import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { plan, applyPatches, revert } from '../lib/engine.js';

async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-modern-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { base: path.join(dir, 'host'), home: path.join(dir, 'data') };
}
async function put(base, rel, data) {
  const file = path.join(base, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file;
}
test('modern renamed constants stay valid, obsolete cwd is never introduced, native permissions untouched', async t => {
  const f = await root(t);
  const intro = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.';
  const source = `const AGENT_INSTRUCTIONS_INTRO = "${intro}";\nconst REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ${intro}";\nconst ADDITIONAL_INSTRUCTIONS_GUIDANCE = "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.";\nexport const render = () => AGENT_INSTRUCTIONS_INTRO + REPLACEMENT_AGENT_INSTRUCTIONS_INTRO + ADDITIONAL_INSTRUCTIONS_GUIDANCE;\n`;
  const instructions = await put(f.base, 'dsh-agent-instructions/lib/index.js', source);
  await put(f.base, 'dsh-agent-instructions/package.json', JSON.stringify({ version: '0.2.1-rc.2', type: 'module' }));
  const config = await put(f.base, 'dsh-web-app/cordis.patch.yml', '- id: system-prompt\n  config:\n    personaPrefix: >-\n      You are a coding agent powered by the {{model}} model.\n');
  const native = await put(f.base, 'dsh-base/cordis.patch.yml', 'permission configuration owned by DSH');
  const preflight = await plan(f); assert.equal(preflight.ok, true);
  assert.equal(preflight.report.filter(r => r.status === 'native_setting').length, 4);
  const result = await applyPatches(f); assert.equal(result.ok, true); assert.equal(result.changed, 2);
  assert.equal((await import(pathToFileURL(instructions).href)).render().includes('ACTIVE and MANDATORY'), true);
  assert.equal((await fs.readFile(config, 'utf8')).includes('{{cwd}}'), false);
  assert.equal(await fs.readFile(native, 'utf8'), 'permission configuration owned by DSH');
  assert.equal((await applyPatches(f)).changed, 0);
  await revert(result.snapshot, f); assert.equal(await fs.readFile(instructions, 'utf8'), source);
});
test('real DSH 0.2.1 source copy: apply, syntax, idempotence and exact rollback', { skip: !process.env.DSH_RUNTIME_ROOT }, async t => {
  const f = await root(t); const originals = new Map();
  for (const rel of ['dsh-agent-instructions/package.json', 'dsh-agent-instructions/lib/index.js', 'dsh-web-app/cordis.patch.yml']) {
    const bytes = await fs.readFile(path.join(process.env.DSH_RUNTIME_ROOT, rel));
    originals.set(await put(f.base, rel, bytes), bytes);
  }
  const preview = await plan(f); assert.equal(preview.ok, true);
  const result = await applyPatches(f); assert.equal(result.ok, true); assert.equal(result.changed, 2);
  const check = spawnSync(process.execPath, ['--check', path.join(f.base, 'dsh-agent-instructions/lib/index.js')], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal((await applyPatches(f)).changed, 0);
  await revert(result.snapshot, f);
  for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes);
});
