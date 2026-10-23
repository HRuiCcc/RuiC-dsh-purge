import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { targetFiles } from './patches.js';
import { hash, atomicWrite, writeJson, readJson, inside, regular, withLock } from './storage.js';
import { homePath } from './paths.js';
import { discoverHost, readHostTarget } from './host.js';
import { compatibility } from './compatibility.js';

const count = (text, needle) => text.split(needle).length - 1;
const canonicalText = text => text.replace(/\r\n/g, '\n');
const snapshotRoot = home => path.join(home, 'ruic-dsh-purge', 'snapshots');
const idPattern = /^[0-9a-f-]{36}$/;

async function readTarget(root, file) {
  const st = await regular(file);
  const real = await fs.realpath(file);
  if (!inside(root, real)) throw new Error(`Target escapes installation: ${file}`);
  return { path: real, before: await fs.readFile(real), mode: st.mode & 0o777 };
}

export async function plan(options = {}) {
  const host = await discoverHost(options);
  const { base } = host;
  const profile = compatibility(host.version);
  const home = homePath(options);
  const files = targetFiles(base);
  const changes = [], report = [];
  for (const [key, file] of Object.entries(files)) {
    const patches = profile.patches.filter(p => p.file === key);
    if (!patches.length) continue;
    let entry;
    try { entry = await readHostTarget(host, file); }
    catch (e) {
      for (const p of patches) report.push({ id: p.id, name: p.name, path: file, status: 'missing_or_unreadable', detail: e.message });
      continue;
    }
    const original = entry.before.toString('utf8');
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    let text = canonicalText(original);
    for (const p of patches) {
      // Full replacement evidence avoids broad markers falsely reporting success.
      const replacement = canonicalText(p.replace);
      const patterns = p.patterns.map(canonicalText);
      const replacedCount = count(text, replacement);
      // An already-patched replacement may itself contain the old prefix (persona).
      const outsideReplacement = text.split(replacement).join('');
      const oldOutside = patterns.reduce((n, pat) => n + count(outsideReplacement, pat), 0);
      let status;
      if (replacedCount === 1 && oldOutside === 0) status = 'applied';
      else if (replacedCount > 0) status = 'ambiguous';
      else {
        const hits = patterns.reduce((n, pat) => n + count(text, pat), 0);
        if (hits === 1) {
          const pat = patterns.find(pat => text.includes(pat));
          text = text.replace(pat, () => replacement);
          status = 'pending';
        } else status = hits ? 'ambiguous' : 'pattern_not_found';
      }
      report.push({ id: p.id, name: p.name, path: entry.path, status });
    }
    const after = Buffer.from(newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text);
    if (!after.equals(entry.before)) changes.push({ ...entry, after });
  }
  if (options.shimDir) {
    const root = await fs.realpath(path.resolve(options.shimDir));
    for (const name of ['dsh.cmd', 'dsh.ps1']) {
      const file = path.join(root, name);
      let entry;
      try { entry = await readTarget(root, file); }
      catch (e) { report.push({ id: name, path: file, status: 'missing_or_unreadable', detail: e.message }); continue; }
      const text = entry.before.toString('utf8');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const injection = name.endsWith('.cmd')
        ? 'REM ruic-dsh-purge shim\nIF NOT DEFINED DSH_PERMISSION_MODE SET "DSH_PERMISSION_MODE=danger-full-access"\n'
        : '# ruic-dsh-purge shim\nif (-not $env:DSH_PERMISSION_MODE) { $env:DSH_PERMISSION_MODE = "danger-full-access" }\n';
      const block = injection.replace(/\n/g, eol);
      if (text.includes(block)) { report.push({ id: name, path: file, status: 'applied' }); continue; }
      if (/dsh-purge shim/.test(text)) { report.push({ id: name, path: file, status: 'ambiguous' }); continue; }
      const offset = text.startsWith('#!') && text.includes('\n') ? text.indexOf('\n') + 1 : 0;
      changes.push({ ...entry, after: Buffer.from(text.slice(0, offset) + block + text.slice(offset)) });
      report.push({ id: name, path: file, status: 'pending' });
    }
  }
  report.push(...profile.nativeSettings);
  return { base, home, host, profile: profile.id, report, changes, ok: report.every(p => ['applied', 'pending', 'native_setting'].includes(p.status)) };
}

export function publicPlan(p) {
  return {
    ok: p.ok, base: p.base, host: p.host, profile: p.profile, report: p.report,
    changes: p.changes.map(c => ({ path: c.path, before: hash(c.before), after: hash(c.after), bytes: c.after.length })),
  };
}

export async function snapshots(options = {}) {
  const root = snapshotRoot(homePath(options));
  let ids;
  try { ids = await fs.readdir(root); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const result = [];
  for (const id of ids.filter(id => idPattern.test(id))) {
    let m;
    try { m = await readJson(path.join(root, id, 'manifest.json')); }
    catch (e) {
      // A process may die during backup staging, before the journal exists.
      // No host writes are possible at that stage; ignore this orphan directory.
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    result.push({ id, created: m.created, base: m.base, state: m.state, files: m.entries.length });
  }
  return result.sort((a, b) => b.created.localeCompare(a.created));
}

async function sameFile(file, digest) {
  await regular(file);
  if (await fs.realpath(file) !== file || hash(await fs.readFile(file)) !== digest) {
    throw new Error(`File changed since preflight: ${file}`);
  }
}

// Each file is replaced atomically. The journal recovers multi-file interruption;
// this is not a filesystem-wide transaction or protection from external writers.
export async function applyPatches(options = {}, write = atomicWrite) {
  const host = await discoverHost(options);
  const { base } = host;
  if (options.dryRun) return { ...publicPlan(await plan(options)), dryRun: true, changed: 0 };
  if (!host.writable) return { ...publicPlan(await plan(options)), ok: false, error: 'Signed ASAR host is read-only. Prompt management and native /permission remain available; host-file patches require an explicitly selected unpacked installation. This tool does not alter the app signature.' };
  return withLock(base, async () => {
    const pending = (await snapshots(options)).find(s => s.base === base && ['prepared', 'applying', 'reverting', 'recovery_required'].includes(s.state));
    if (pending) throw new Error(`Unfinished snapshot ${pending.id}; run revert ${pending.id} before applying again.`);
    const p = await plan({ ...options, base });
    if (!p.ok) return { ...publicPlan(p), error: 'Preflight failed; no target files changed.' };
    if (!p.changes.length || options.dryRun) return { ...publicPlan(p), dryRun: Boolean(options.dryRun), changed: 0 };
    const id = randomUUID();
    const dir = path.join(snapshotRoot(p.home), id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const manifest = { version: 1, id, base, created: new Date().toISOString(), state: 'prepared', entries: [] };
    // All backups must be written, synced and hash-verified before the first host write.
    const manifestFile = path.join(dir, 'manifest.json');
    try {
      for (const [i, change] of p.changes.entries()) {
        const backup = `${i}.bin`;
        await atomicWrite(path.join(dir, backup), change.before);
        const before = hash(change.before), after = hash(change.after);
        if (hash(await fs.readFile(path.join(dir, backup))) !== before) throw new Error('Backup verification failed');
        manifest.entries.push({ path: change.path, backup, before, after, mode: change.mode });
      }
      await writeJson(manifestFile, manifest);
    } catch (error) {
      // No host writes occurred. Discard only this incomplete, newly owned staging directory.
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
    const written = [];
    try {
      for (const e of manifest.entries) await sameFile(e.path, e.before);
      manifest.state = 'applying';
      await writeJson(manifestFile, manifest);
      for (const [i, change] of p.changes.entries()) {
        await sameFile(change.path, manifest.entries[i].before);
        await write(change.path, change.after, change.mode);
        written.push(i);
        await sameFile(change.path, manifest.entries[i].after);
      }
      manifest.state = 'applied';
      await writeJson(manifestFile, manifest);
      return { ...publicPlan(p), changed: written.length, snapshot: id, note: '文件已写入；请手动重启 DSH。' };
    } catch (error) {
      const recoveryErrors = [];
      for (const i of written.reverse()) {
        const c = p.changes[i];
        try { await sameFile(c.path, hash(c.after)); await atomicWrite(c.path, c.before, c.mode); }
        catch (e) { recoveryErrors.push(e.message); }
      }
      manifest.state = recoveryErrors.length ? 'recovery_required' : 'rolled_back';
      manifest.error = error.message;
      manifest.recoveryErrors = recoveryErrors;
      await writeJson(manifestFile, manifest);
      return { ok: false, error: error.message, snapshot: id, state: manifest.state, recoveryErrors };
    }
  });
}

export async function revert(id, options = {}) {
  if (!idPattern.test(id || '')) throw new Error('A valid snapshot ID is required. Run snapshots first.');
  const dir = path.join(snapshotRoot(homePath(options)), id);
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = await readJson(manifestFile);
  if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.entries)) throw new Error('Invalid snapshot manifest');
  const host = await discoverHost(options);
  const { base } = host;
  if (!host.writable) throw new Error('Select the original unpacked installation to restore this snapshot.');
  if (base !== manifest.base) throw new Error('Snapshot belongs to another DSH installation; select its --base.');
  return withLock(base, async () => {
    const prepared = [];
    const allowed = new Set(Object.values(targetFiles(base)).map(p => path.resolve(p)));
    for (const file of [...allowed]) {
      try {
        const real = await fs.realpath(file);
        if (inside(base, real)) allowed.add(real);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (options.shimDir) {
      const root = await fs.realpath(options.shimDir);
      for (const name of ['dsh.cmd', 'dsh.ps1']) allowed.add(path.join(root, name));
    }
    for (const [i, entry] of manifest.entries.entries()) {
      if (!allowed.has(entry.path) || entry.backup !== `${i}.bin`) throw new Error('Unexpected target or backup in manifest; use the original --shim-dir if applicable.');
      await regular(path.join(dir, entry.backup));
      const bytes = await fs.readFile(path.join(dir, entry.backup));
      if (hash(bytes) !== entry.before) throw new Error(`Backup checksum mismatch: ${entry.backup}`);
      await regular(entry.path);
      if (await fs.realpath(entry.path) !== entry.path) throw new Error(`Target path changed: ${entry.path}`);
      const current = hash(await fs.readFile(entry.path));
      if (current !== entry.before && current !== entry.after) throw new Error(`Rollback conflict: ${entry.path}. Current edits were preserved.`);
      prepared.push({ ...entry, bytes, current });
    }
    if (options.dryRun) return { ok: true, dryRun: true, snapshot: id, files: prepared.filter(e => e.current !== e.before).map(e => e.path) };
    manifest.state = 'reverting';
    await writeJson(manifestFile, manifest);
    let changed = 0;
    try {
      for (const entry of prepared) {
        await sameFile(entry.path, entry.current);
        if (entry.current === entry.before) continue;
        await atomicWrite(entry.path, entry.bytes, entry.mode);
        await sameFile(entry.path, entry.before);
        changed++;
      }
      manifest.state = 'reverted';
      await writeJson(manifestFile, manifest);
      return { ok: true, snapshot: id, changed, note: '已还原；快照与用户提示词保留。请手动重启 DSH。' };
    } catch (e) {
      manifest.state = 'recovery_required';
      manifest.error = e.message;
      await writeJson(manifestFile, manifest);
      throw e;
    }
  });
}
