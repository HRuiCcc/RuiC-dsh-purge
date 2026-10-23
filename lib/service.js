import fs from 'node:fs/promises';
import { version } from './version.js';
import path from 'node:path';
import { plan, publicPlan, applyPatches, snapshots, revert } from './engine.js';
import { homePath } from './paths.js';
import { atomicWrite, hash, regular, withLock } from './storage.js';

export const promptPath = options => path.join(homePath(options), 'ruic-dsh-purge', 'prompt.md');
export async function readPrompt(options = {}) {
  const file = promptPath(options);
  let content = '';
  try { await regular(file); content = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ok: true, path: file, content, hash: hash(content) };
}
export async function savePrompt(content, expectedHash, options = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) throw new Error('Prompt must be text, at most 128 KiB.');
  if (typeof expectedHash !== 'string') throw new Error('Missing prompt revision; reload the saved prompt.');
  const dir = path.dirname(promptPath(options));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return withLock(dir, async () => {
    const previous = await readPrompt(options);
    if (previous.hash !== expectedHash) throw new Error('Prompt changed in another window. Your draft was not saved; reload before retrying.');
    await atomicWrite(previous.path, content);
    return { ok: true, path: previous.path, hash: hash(content), note: '提示词已保存，后续提示词构建时读取。' };
  });
}
export async function status(options = {}) {
  const p = await plan(options);
  const history = (await snapshots(options)).filter(s => s.base === p.base);
  const interrupted = history.filter(s => ['prepared', 'applying', 'reverting', 'recovery_required'].includes(s.state));
  return {
    ...publicPlan(p), ok: p.ok && !interrupted.length, version,
    state: !p.ok ? 'incompatible' : interrupted.length ? 'recovery_required' : !p.host.writable ? 'sealed' : p.changes.length ? 'pending' : 'applied',
    applied: p.report.filter(r => r.status === 'applied').length,
    total: p.report.filter(r => r.status !== 'native_setting').length, snapshots: history, interrupted,
    permissions: options.permissionState?.() || { source: 'unknown', scope: 'current_session_unknown', note: 'Use DSH /permission to inspect or change the current session.' },
    promptPath: promptPath(options),
  };
}
export async function run(command, options = {}, argument) {
  switch (command) {
    case 'status': case 'selfcheck': return status(options);
    case 'plan': return publicPlan(await plan(options));
    case 'apply': return applyPatches(options);
    case 'revert': return revert(argument, options);
    case 'snapshots': return { ok: true, snapshots: await snapshots(options) };
    default: throw new Error(`Unknown command: ${command}`);
  }
}
