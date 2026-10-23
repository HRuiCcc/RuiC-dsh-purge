import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { resolveBase } from './paths.js';

const ARCHIVE_BASE = 'dsh/node_modules/@deepseek-ai';
const MAX_HEADER = 64 * 1024 * 1024;
const MAX_MEMBER = 64 * 1024 * 1024;
const own = (object, key) => Object.hasOwn(object, key);

function fail(message, code = 'DSH_HOST_INVALID') {
  return Object.assign(new Error(message), { code });
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function readExact(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(bytes, done, length - done, position + done);
    if (!bytesRead) throw fail('Truncated ASAR member or header.');
    done += bytesRead;
  }
  return bytes;
}

// ASAR has a size pickle (8 bytes), followed by a header pickle containing
// one length-prefixed JSON string. Offsets are relative to the end of both.
async function openArchive(archive) {
  const handle = await fs.open(archive, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 16) throw fail('Invalid ASAR file.');
    const prefix = await readExact(handle, 16, 0);
    const [sizePayload, headerSize, payloadSize, jsonSize] = [0, 4, 8, 12].map(i => prefix.readUInt32LE(i));
    if (sizePayload !== 4 || headerSize < 8 || headerSize > MAX_HEADER || headerSize % 4 !== 0 ||
        payloadSize !== headerSize - 4 || jsonSize === 0 ||
        8 + Math.ceil(jsonSize / 4) * 4 !== headerSize || 8 + headerSize > stat.size) {
      throw fail('Invalid ASAR pickle header bounds.');
    }
    const header = JSON.parse((await readExact(handle, jsonSize, 16)).toString('utf8'));
    if (!header || typeof header.files !== 'object' || Array.isArray(header.files)) throw fail('ASAR header has no file tree.');
    return { handle, header, dataOffset: 8 + headerSize, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

function memberNode(header, member) {
  const parts = member.split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    throw fail('Invalid ASAR member path.');
  }
  let node = header;
  for (const part of parts) {
    // Do not follow ASAR link metadata: a linked package is not a verified
    // target, even when its destination appears to be inside this archive.
    if (own(node, 'link')) throw fail('ASAR linked members are not supported.');
    if (!node.files || !own(node.files, part)) throw fail(`ASAR member not found: ${member}`, 'ENOENT');
    node = node.files[part];
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw fail('Invalid ASAR member metadata.');
  }
  if (own(node, 'link')) throw fail('ASAR linked members are not supported.');
  return node;
}

async function readArchiveMember(archive, member) {
  const opened = await openArchive(archive);
  try {
    const node = memberNode(opened.header, member);
    if (node.files || !Number.isSafeInteger(node.size) || node.size < 0 || node.size > MAX_MEMBER) {
      throw fail('Invalid or oversized ASAR file metadata.');
    }
    if (node.unpacked !== undefined && typeof node.unpacked !== 'boolean') throw fail('Invalid ASAR unpacked metadata.');
    let before;
    if (node.unpacked) {
      const root = await fs.realpath(`${archive}.unpacked`);
      const target = await fs.realpath(path.join(`${archive}.unpacked`, ...member.split('/')));
      if (!contained(root, target)) throw fail('ASAR unpacked member escapes its root.');
      const stat = await fs.stat(target);
      if (!stat.isFile() || stat.size !== node.size) throw fail('ASAR unpacked member size does not match metadata.');
      before = await fs.readFile(target);
      if (before.length !== node.size) throw fail('ASAR unpacked member changed during read.');
    } else {
      if (typeof node.offset !== 'string' || !/^(0|[1-9]\d*)$/.test(node.offset)) throw fail('Invalid ASAR member offset.');
      const offset = Number(node.offset);
      const position = opened.dataOffset + offset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position) ||
          node.size > opened.size - position || position > opened.size) throw fail('ASAR member exceeds archive bounds.');
      before = await readExact(opened.handle, node.size, position);
    }
    return { before, mode: node.executable === true ? 0o755 : 0o644 };
  } finally { await opened.handle.close(); }
}

async function archiveHost(archive, requestedMember) {
  const canonicalArchive = await fs.realpath(archive);
  if (requestedMember && requestedMember !== ARCHIVE_BASE) throw fail(`Expected ASAR package base ${ARCHIVE_BASE}.`);
  const opened = await openArchive(canonicalArchive);
  try {
    const node = memberNode(opened.header, ARCHIVE_BASE);
    if (!node.files) throw fail('ASAR package base is not a directory.');
    memberNode(opened.header, `${ARCHIVE_BASE}/dsh-agent-instructions/lib/index.js`);
  } finally { await opened.handle.close(); }
  const host = { base: path.join(canonicalArchive, ...ARCHIVE_BASE.split('/')), version: null, layout: 'asar', writable: false, archive: canonicalArchive };
  host.version = (await readHostPackage(host, 'dsh-agent-instructions'))?.version ?? null;
  if (!host.version) {
    try { host.version = JSON.parse((await readArchiveMember(canonicalArchive, 'dsh/package.json')).before.toString('utf8')).version ?? null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return host;
}

async function directoryHost(base) {
  const canonical = await fs.realpath(base);
  if (!(await fs.stat(canonical)).isDirectory()) throw fail('DSH package base is not a directory.');
  const host = { base: canonical, version: null, layout: 'directory', writable: false };
  await readHostTarget(host, path.join(canonical, 'dsh-agent-instructions', 'lib', 'index.js'));
  host.version = (await readHostPackage(host, 'dsh-agent-instructions'))?.version ?? null;
  try { await fs.access(canonical, constants.W_OK); host.writable = true; } catch { /* Read-only installation. */ }
  return host;
}

async function discoverAt(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('DSH base must be a nonempty path.');
  const absolute = path.resolve(input);
  const components = absolute.split(path.sep);
  const archiveIndex = components.findIndex(part => part.toLowerCase().endsWith('.asar'));
  if (archiveIndex >= 0) {
    const archive = components.slice(0, archiveIndex + 1).join(path.sep);
    return archiveHost(archive, components.slice(archiveIndex + 1).join('/'));
  }
  const resourceRoot = absolute.endsWith('.app') ? path.join(absolute, 'Contents', 'Resources') : absolute;
  const archive = path.join(resourceRoot, 'app.asar');
  if (await exists(archive)) return archiveHost(archive);
  for (const candidate of [absolute, path.join(resourceRoot, 'app', ...ARCHIVE_BASE.split('/')), path.join(resourceRoot, ...ARCHIVE_BASE.split('/'))]) {
    if (await exists(path.join(candidate, 'dsh-agent-instructions', 'lib', 'index.js'))) return directoryHost(candidate);
  }
  throw fail(`No DSH package base at ${absolute}.`, 'DSH_HOST_NOT_FOUND');
}

/** Discover one host, honoring an explicit selection without silent fallback. */
export async function discoverHost(options = {}) {
  if (options.base !== undefined) return discoverAt(options.base);
  if (process.env.DSH_BASE !== undefined) return discoverAt(process.env.DSH_BASE);
  const desktopCandidates = [process.resourcesPath, '/Applications/DeepSeek Harness.app'].filter(Boolean);
  for (const candidate of desktopCandidates) {
    try { return await discoverAt(candidate); } catch (error) {
      if (!['DSH_HOST_NOT_FOUND', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return directoryHost(await resolveBase(options));
}

/** Read exactly one target; this module never modifies a host installation. */
export async function readHostTarget(host, fileAbsolute) {
  if (!path.isAbsolute(fileAbsolute)) throw fail('Host target must be an absolute path.');
  const target = path.resolve(fileAbsolute);
  if (!contained(host.base, target) || target === host.base) throw fail('Host target escapes its package base.');
  if (host.layout === 'asar') {
    const member = path.relative(host.archive, target).split(path.sep).join('/');
    return { path: target, ...await readArchiveMember(host.archive, member) };
  }
  const canonical = await fs.realpath(target);
  if (!contained(host.base, canonical)) throw fail('Host target resolves outside its package base.');
  const handle = await fs.open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail('Host target is not a regular file.');
    return { path: canonical, before: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}

/** Read package metadata only; missing packages have no metadata. */
export async function readHostPackage(host, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw fail('Invalid host package name.');
  try {
    const { before } = await readHostTarget(host, path.join(host.base, name, 'package.json'));
    const value = JSON.parse(before.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid package metadata.');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
