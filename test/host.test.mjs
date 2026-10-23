import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverHost, readHostTarget, readHostPackage } from '../lib/host.js';

const memberBase = 'dsh/node_modules/@deepseek-ai';
const entry = `${memberBase}/dsh-agent-instructions/lib/index.js`;
const packageEntry = `${memberBase}/dsh-agent-instructions/package.json`;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}

function setNode(header, member, node) {
  const parts = member.split('/');
  let directory = header;
  for (const part of parts.slice(0, -1)) directory = directory.files[part] ??= { files: {} };
  directory.files[parts.at(-1)] = node;
}

// Synthetic Electron ASAR: size pickle + header pickle + ordered file bytes.
async function writeAsar(archive, files, mutate = () => {}) {
  const header = { files: {} }, chunks = [];
  let offset = 0;
  for (const [member, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    setNode(header, member, { offset: String(offset), size: bytes.length });
    chunks.push(bytes); offset += bytes.length;
  }
  mutate(header);
  const json = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, Buffer.concat([prefix, ...chunks]));
}

const fixtureFiles = () => ({
  [entry]: 'export const version = "modern";\n',
  [packageEntry]: JSON.stringify({ name: '@deepseek-ai/dsh-agent-instructions', version: '0.2.1-rc.2' }),
  'dsh/package.json': JSON.stringify({ version: '0.2.1-rc.2' }),
  // A duplicate in Electron's own dependency tree must never be selected.
  'node_modules/@deepseek-ai/dsh-agent-instructions/package.json': '{"version":"wrong"}',
});

test('directory discovery reads canonical targets and allows absent package metadata', async t => {
  const root = await temporary(t);
  const base = path.join(root, '@deepseek-ai');
  const file = path.join(base, 'dsh-agent-instructions', 'lib', 'index.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'directory host\n', { mode: 0o640 });
  const host = await discoverHost({ base });
  assert.equal(host.base, await fs.realpath(base));
  assert.equal(host.layout, 'directory');
  assert.equal(host.version, null);
  assert.equal(host.writable, true);
  const read = await readHostTarget(host, file);
  assert.equal(read.before.toString(), 'directory host\n');
  if (process.platform !== 'win32') assert.equal(read.mode, 0o640);
  assert.equal(await readHostPackage(host, 'missing'), null);
  await assert.rejects(readHostPackage(host, '../escape'), /Invalid host package/);
});

test('directory targets reject lexical and canonical symlink escape', async t => {
  const root = await temporary(t);
  const base = path.join(root, 'base');
  const file = path.join(base, 'dsh-agent-instructions/lib/index.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'host');
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, 'private');
  const host = await discoverHost({ base });
  await assert.rejects(readHostTarget(host, outside), /escapes/);
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(base, 'linked'));
    await assert.rejects(readHostTarget(host, path.join(base, 'linked')), /outside/);
  }
  await assert.rejects(readHostTarget(host, 'relative'), /absolute/);
});

test('explicit missing paths never fall back to the installed desktop host', async t => {
  const root = await temporary(t);
  await assert.rejects(discoverHost({ base: path.join(root, 'missing') }), /No DSH package base/);
  await assert.rejects(discoverHost({ base: '' }), /nonempty/);
  const prior = process.env.DSH_BASE;
  process.env.DSH_BASE = path.join(root, 'missing-env');
  try { await assert.rejects(discoverHost(), /missing-env/); }
  finally { if (prior === undefined) delete process.env.DSH_BASE; else process.env.DSH_BASE = prior; }
});

test('ASAR is sealed and readable through app, Resources, archive and virtual package paths', async t => {
  const root = await temporary(t);
  const app = path.join(root, 'Harness.app');
  const resources = path.join(app, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  const files = fixtureFiles();
  await writeAsar(archive, files);
  const before = await fs.readFile(archive);
  for (const base of [app, resources, archive, path.join(archive, memberBase)]) {
    const host = await discoverHost({ base });
    assert.equal(host.layout, 'asar');
    assert.equal(host.writable, false);
    assert.equal(host.archive, await fs.realpath(archive));
    assert.equal(host.version, '0.2.1-rc.2');
    assert.equal(host.base, path.join(await fs.realpath(archive), memberBase));
    assert.equal((await readHostTarget(host, path.join(host.base, 'dsh-agent-instructions/lib/index.js'))).before.toString(), files[entry]);
    assert.equal(await readHostPackage(host, 'missing'), null);
  }
  assert.deepEqual(await fs.readFile(archive), before);
  await assert.rejects(discoverHost({ base: path.join(archive, 'node_modules/@deepseek-ai') }), /Expected ASAR package base/);
});

test('ASAR version falls back to dsh/package.json when package metadata is absent', async t => {
  const archive = path.join(await temporary(t), 'app.asar');
  const files = fixtureFiles(); delete files[packageEntry];
  await writeAsar(archive, files);
  assert.equal((await discoverHost({ base: archive })).version, '0.2.1-rc.2');
});

test('ASAR header bounds are validated before allocating or parsing', async t => {
  const archive = path.join(await temporary(t), 'bad.asar');
  for (const malformed of [Buffer.alloc(15), Buffer.from('not an asar archive at all')]) {
    await fs.writeFile(archive, malformed);
    await assert.rejects(discoverHost({ base: archive }), /Invalid ASAR/);
  }
  await writeAsar(archive, fixtureFiles());
  const bytes = await fs.readFile(archive);
  bytes.writeUInt32LE(0xffffffff, 4);
  await fs.writeFile(archive, bytes);
  await assert.rejects(discoverHost({ base: archive }), /header bounds/);
});

test('ASAR offsets and sizes cannot read outside the archive', async t => {
  const archive = path.join(await temporary(t), 'app.asar');
  for (const node of [
    { offset: '-1', size: 1 }, { offset: '9007199254740992', size: 1 },
    { offset: '9999999', size: 1 }, { offset: '0', size: 99999999 },
    { offset: '0', size: -1 }, { offset: 0, size: 1 },
  ]) {
    await writeAsar(archive, fixtureFiles(), header => setNode(header, entry, node));
    const host = await discoverHost({ base: archive });
    await assert.rejects(readHostTarget(host, path.join(host.base, 'dsh-agent-instructions/lib/index.js')), /ASAR/);
  }
});

test('ASAR links are refused at leaf and parent levels', async t => {
  const archive = path.join(await temporary(t), 'app.asar');
  for (const member of [entry, `${memberBase}/dsh-agent-instructions`]) {
    await writeAsar(archive, fixtureFiles(), header => setNode(header, member, { link: '../../outside' }));
    await assert.rejects(discoverHost({ base: archive }), /linked members/);
  }
});

test('unpacked ASAR members require matching size and canonical containment', async t => {
  const root = await temporary(t), archive = path.join(root, 'app.asar');
  const unpacked = path.join(`${archive}.unpacked`, entry);
  const content = Buffer.from('unpacked member');
  await writeAsar(archive, fixtureFiles(), header => setNode(header, entry, { unpacked: true, size: content.length, executable: true }));
  await fs.mkdir(path.dirname(unpacked), { recursive: true });
  await fs.writeFile(unpacked, content);
  const host = await discoverHost({ base: archive });
  const virtual = path.join(host.base, 'dsh-agent-instructions/lib/index.js');
  const read = await readHostTarget(host, virtual);
  assert.deepEqual(read.before, content);
  assert.equal(read.mode, 0o755);
  assert.equal(host.writable, false);
  await fs.writeFile(unpacked, 'wrong size');
  await assert.rejects(readHostTarget(host, virtual), /size does not match/);
  await fs.unlink(unpacked);
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, content);
  if (process.platform !== 'win32') {
    await fs.symlink(outside, unpacked);
    await assert.rejects(readHostTarget(host, virtual), /escapes/);
  }
});

test('archive member reads enforce the selected package boundary', async t => {
  const archive = path.join(await temporary(t), 'app.asar');
  await writeAsar(archive, fixtureFiles());
  const host = await discoverHost({ base: archive });
  await assert.rejects(readHostTarget(host, path.join(host.archive, 'dsh/package.json')), /escapes/);
});
