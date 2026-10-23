import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALL_PATCHES, targetFiles } from '../lib/patches.js';
import { plan, applyPatches, revert, snapshots } from '../lib/engine.js';
import { atomicWrite, readJson, writeJson } from '../lib/storage.js';
import { readPrompt, savePrompt } from '../lib/service.js';

async function fixture(t, eol = '\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-purge-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'host'), home = path.join(root, 'home');
  const originals = new Map();
  for (const [key, file] of Object.entries(targetFiles(base))) {
    // Synthetic host assembled from exact upstream anchors; NOT a real DSH build.
    const content = ALL_PATCHES.filter(p => p.file === key).map(p => p.patterns[0]).join('\n;\n').replace(/\n/g, eol);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    originals.set(file, content);
  }
  return { base, home, originals, root };
}
async function unchanged(f) {
  for (const [file, text] of f.originals) assert.equal(await fs.readFile(file, 'utf8'), text);
}
test('preview, verified apply, idempotence and exact byte rollback; preserves user prompts', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.home);
  await fs.writeFile(path.join(f.home, 'prompt-inject.md'), 'User original 🧪');
  assert.equal((await plan(f)).report.filter(r => r.status === 'pending').length, 8);
  await unchanged(f);
  const result = await applyPatches(f);
  assert.equal(result.ok, true);
  assert.equal(result.changed, 5);
  assert.equal((await plan(f)).report.filter(r => r.status === 'applied').length, 8);
  assert.equal((await applyPatches(f)).changed, 0);
  assert.equal((await snapshots(f)).length, 1);
  const preview = await revert(result.snapshot, { ...f, dryRun: true });
  assert.equal(preview.files.length, 5);
  assert.equal((await revert(result.snapshot, f)).changed, 5);
  await unchanged(f);
  assert.equal((await revert(result.snapshot, f)).changed, 0);
  assert.equal(await fs.readFile(path.join(f.home, 'prompt-inject.md'), 'utf8'), 'User original 🧪');
});
test('CRLF sources retain CRLF on apply and byte-exact rollback', async t => {
  const f = await fixture(t, '\r\n');
  const result = await applyPatches(f);
  assert.equal(result.ok, true);
  for (const file of f.originals.keys()) assert.equal(/(?<!\r)\n/.test(await fs.readFile(file, 'utf8')), false);
  await revert(result.snapshot, f); await unchanged(f);
});
test('anchor drift aborts entire apply before backup or target writes', async t => {
  const f = await fixture(t);
  const file = targetFiles(f.base).base;
  await fs.writeFile(file, 'upgraded host'); f.originals.set(file, 'upgraded host');
  const result = await applyPatches(f);
  assert.equal(result.ok, false);
  assert.equal(result.report.some(r => r.status === 'pattern_not_found'), true);
  await unchanged(f); assert.deepEqual(await snapshots(f), []);
});
test('ambiguous duplicate anchors and partial replacements do not count as applied', async t => {
  const f = await fixture(t);
  const file = targetFiles(f.base)['sandbox-local'];
  await fs.appendFile(file, '\n' + ALL_PATCHES[5].patterns[0]);
  assert.equal((await plan(f)).report.find(r => r.id === 6).status, 'ambiguous');
  await fs.writeFile(file, ALL_PATCHES[5].replace + '\n' + ALL_PATCHES[5].patterns[0]);
  assert.equal((await plan(f)).report.find(r => r.id === 6).status, 'ambiguous');
});
test('mid-write failure rolls previously written files back and keeps journal', async t => {
  const f = await fixture(t);
  let writes = 0;
  const result = await applyPatches(f, async (...args) => {
    if (++writes === 3) throw new Error('simulated disk failure');
    return atomicWrite(...args);
  });
  assert.equal(result.ok, false); assert.equal(result.state, 'rolled_back');
  await unchanged(f);
  assert.equal((await snapshots(f))[0].state, 'rolled_back');
});
test('backup destination failure never writes host files', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.home); await fs.writeFile(path.join(f.home, 'ruic-dsh-purge'), 'blocked');
  await assert.rejects(applyPatches(f)); await unchanged(f);
});
test('rollback conflict preflights all files and preserves subsequent edits', async t => {
  const f = await fixture(t); const result = await applyPatches(f);
  const files = [...f.originals.keys()];
  await fs.appendFile(files.at(-1), '\nuser edit');
  const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
  await assert.rejects(revert(result.snapshot, f), /conflict/);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
});
test('tampered backup and traversal IDs are rejected', async t => {
  const f = await fixture(t); const result = await applyPatches(f);
  await fs.writeFile(path.join(f.home, 'ruic-dsh-purge', 'snapshots', result.snapshot, '0.bin'), 'corrupt');
  await assert.rejects(revert(result.snapshot, f), /checksum/);
  await assert.rejects(revert('../../escape', f), /valid snapshot/);
});
test('unfinished journal blocks new apply and permits interrupted-operation recovery', async t => {
  const f = await fixture(t); const result = await applyPatches(f);
  const manifestPath = path.join(f.home, 'ruic-dsh-purge', 'snapshots', result.snapshot, 'manifest.json');
  const manifest = await readJson(manifestPath);
  manifest.state = 'applying'; await writeJson(manifestPath, manifest);
  // Simulate one file already restored after an interruption.
  const [first, bytes] = f.originals.entries().next().value;
  await fs.writeFile(first, bytes);
  await assert.rejects(applyPatches(f), /Unfinished snapshot/);
  assert.equal((await revert(result.snapshot, f)).ok, true); await unchanged(f);
});
test('cross-process lock prevents writes and is not automatically removed', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.base, '.ruic-dsh-purge.lock'), 'another process');
  await assert.rejects(applyPatches(f), /locked/); await unchanged(f);
  assert.equal(await fs.readFile(path.join(f.base, '.ruic-dsh-purge.lock'), 'utf8'), 'another process');
});
test('target symlinks are refused and external bytes stay intact', async t => {
  if (process.platform === 'win32') { t.skip('Symlink privileges vary on Windows CI'); return; }
  const f = await fixture(t); const target = targetFiles(f.base)['sandbox-local'];
  const outside = path.join(f.root, 'outside'); await fs.copyFile(target, outside);
  const before = await fs.readFile(outside);
  await fs.unlink(target); await fs.symlink(outside, target);
  assert.equal((await applyPatches(f)).ok, false);
  assert.deepEqual(await fs.readFile(outside), before);
});
test('explicit Windows shims join snapshot and retain explicit permission overrides', async t => {
  const f = await fixture(t); const shimDir = path.join(f.root, 'npm'); await fs.mkdir(shimDir);
  await fs.writeFile(path.join(shimDir, 'dsh.cmd'), '@ECHO off\r\nnode dsh.js\r\n');
  await fs.writeFile(path.join(shimDir, 'dsh.ps1'), '#!/usr/bin/env pwsh\r\nnode dsh.js\r\n');
  const result = await applyPatches({ ...f, shimDir }); assert.equal(result.ok, true); assert.equal(result.changed, 7);
  assert.match(await fs.readFile(path.join(shimDir, 'dsh.cmd'), 'utf8'), /IF NOT DEFINED/);
  assert.equal((await applyPatches({ ...f, shimDir })).changed, 0);
  await assert.rejects(revert(result.snapshot, f), /original --shim-dir/);
  await revert(result.snapshot, { ...f, shimDir });
  assert.equal(await fs.readFile(path.join(shimDir, 'dsh.ps1'), 'utf8'), '#!/usr/bin/env pwsh\r\nnode dsh.js\r\n');
});
test('prompt compare-and-save rejects stale revisions without losing CJK/emoji', async t => {
  const f = await fixture(t); const original = await readPrompt(f);
  const saved = await savePrompt('中文 🧪', original.hash, f);
  await assert.rejects(savePrompt('stale draft', original.hash, f), /another window/);
  assert.equal((await readPrompt(f)).content, '中文 🧪');
  await savePrompt('', saved.hash, f); assert.equal((await readPrompt(f)).content, '');
  await assert.rejects(savePrompt('x'.repeat(131073), saved.hash, f), /128 KiB/);
});
test('CLI JSON is parseable; preview is read-only; incompatible status exits nonzero', async t => {
  const f = await fixture(t);
  const cli = path.resolve('bin/ruic-dsh-purge.js');
  const invoke = args => spawnSync(process.execPath, [cli, ...args, '--base', f.base, '--home', f.home, '--json'], { encoding: 'utf8' });
  let result = invoke(['apply', '--dry-run']); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).dryRun, true);
  await unchanged(f); assert.deepEqual(await snapshots(f), []);
  await fs.unlink(targetFiles(f.base).base);
  result = invoke(['selfcheck']); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false);
  result = invoke(['apply', '--typo']); assert.equal(result.status, 1); assert.match(JSON.parse(result.stdout).error, /Unknown option/);
});
