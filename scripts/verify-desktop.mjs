#!/usr/bin/env node
// Verify this plugin against a real DSH installation without modifying it.
// The sealed app.asar is only read: target files are copied to a temp base,
// and every apply/revert proof runs on that copy.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverHost, readHostTarget, materializeArchive } from '../lib/host.js';
import { targetFiles } from '../lib/patches.js';
import { plan, applyPatches, revert } from '../lib/engine.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const full = argv.includes('--full');
const app = value('--app') || value('--base');

function value(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
}

function stamp(file) {
  return fs.stat(file).then(stat => `${stat.size}:${stat.mtimeMs}`, () => null);
}

async function copyTargets(host, destination) {
  const copied = [];
  const files = [...Object.values(targetFiles(host.base)), path.join(host.base, 'dsh-agent-instructions', 'package.json')];
  for (const source of files) {
    const { before, mode } = await readHostTarget(host, source);
    const relative = path.relative(host.base, source);
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, before, { mode: mode ?? 0o644 });
    copied.push(relative);
  }
  return copied;
}

async function main() {
  const steps = [];
  const host = await discoverHost(app ? { base: app } : {});
  const before = host.archive ? await stamp(host.archive) : null;

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-verify-'));
  try {
    const base = path.join(work, 'host');
    const home = path.join(work, 'data');
    await copyTargets(host, base);

    const preflight = await plan({ base, home });
    steps.push({ step: 'plan', ok: preflight.ok, profile: preflight.profile, report: preflight.report });
    if (!preflight.ok) return finish(host, before, steps, preflight.error || 'Preflight did not match the installed host.');

    const changed = preflight.report.filter(entry => entry.status === 'pending').map(entry => entry.id);
    const originals = new Map();
    for (const relative of ['dsh-agent-instructions/lib/index.js', 'dsh-web-app/cordis.patch.yml']) {
      const file = path.join(base, relative);
      originals.set(file, await fs.readFile(file));
    }

    const applied = await applyPatches({ base, home });
    steps.push({ step: 'apply', ok: applied.ok, changed: applied.changed, snapshot: applied.snapshot, error: applied.error });
    if (!applied.ok) return finish(host, before, steps, applied.error || 'Apply failed.');

    const syntax = spawnSync(process.execPath, ['--check', path.join(base, 'dsh-agent-instructions/lib/index.js')], { encoding: 'utf8' });
    steps.push({ step: 'syntax', ok: syntax.status === 0, detail: syntax.status === 0 ? null : syntax.stderr.trim() });
    if (syntax.status !== 0) return finish(host, before, steps, 'Patched host module does not parse.');

    const again = await applyPatches({ base, home });
    steps.push({ step: 'idempotence', ok: again.ok && again.changed === 0, changed: again.changed, error: again.error });
    if (!again.ok || again.changed !== 0) return finish(host, before, steps, 'Second apply was not a no-op.');

    const restored = await revert(applied.snapshot, { base, home });
    steps.push({ step: 'revert', ok: restored.ok, error: restored.error });
    if (!restored.ok) return finish(host, before, steps, restored.error || 'Revert failed.');

    for (const [file, bytes] of originals) {
      const current = await fs.readFile(file);
      if (!current.equals(bytes)) return finish(host, before, steps, `Revert is not byte-exact: ${path.relative(base, file)}`);
    }
    steps.push({ step: 'byte-exact-revert', ok: true, files: [...originals.keys()].map(file => path.relative(base, file)) });

    if (full) {
      const memberRoot = host.archive ? path.relative(host.archive, host.base).split(path.sep).join('/') : null;
      if (!memberRoot) {
        steps.push({ step: 'runtime-suite', ok: true, skipped: '目录布局；请直接以该目录作为 DSH_RUNTIME_ROOT 运行 npm test' });
      } else {
        // Bare imports like @deepseek-ai/cosmokit resolve through sibling
        // node_modules, so the copy must keep the real npm layout.
        const modules = path.posix.dirname(memberRoot);
        const extracted = await materializeArchive(host.archive, modules, path.join(work, 'node_modules'));
        steps.push({
          step: 'materialize', ok: true, files: extracted.files.length,
          skipped: extracted.skipped.map(entry => entry.member),
        });
        const suite = spawnSync(process.execPath, ['--test'], {
          cwd: projectRoot, encoding: 'utf8',
          env: { ...process.env, DSH_RUNTIME_ROOT: path.join(work, 'node_modules', '@deepseek-ai') },
        });
        steps.push({ step: 'runtime-suite', ok: suite.status === 0, detail: suite.status === 0 ? null : (suite.stdout + suite.stderr).trim().split('\n').slice(-12).join('\n') });
      }
    }
    return finish(host, before, steps, null, changed);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function finish(host, before, steps, error, changed = []) {
  const after = host.archive ? await stamp(host.archive) : null;
  const untouched = before === after;
  const ok = !error && steps.every(step => step.ok) && untouched;
  const result = {
    ok, error: error || (untouched ? null : 'The sealed archive changed during verification.'),
    host: { version: host.version, layout: host.layout, writable: host.writable },
    archiveUntouched: untouched,
    patched: changed,
    steps,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`RuiC DSH Purge · 实机验证 · ${ok ? 'PASS' : 'FAIL'}`);
    console.log(`宿主 ${host.version || 'unknown'} · ${host.layout}${host.writable ? ' · 可写' : ' · 只读'}`);
    for (const step of steps) console.log(`  ${step.ok ? '✓' : '✗'} ${step.step}${step.detail ? ` — ${step.detail}` : ''}`);
    console.log(`  ${untouched ? '✓' : '✗'} 原包未被改动`);
    if (error) console.log(`\n${error}`);
    console.log('\n补丁与回滚在临时副本上完成；本脚本不写入任何安装目录。');
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch(error => {
  if (json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  else console.log(`RuiC DSH Purge · 实机验证 · FAIL\n${error.message}`);
  process.exitCode = 1;
});
