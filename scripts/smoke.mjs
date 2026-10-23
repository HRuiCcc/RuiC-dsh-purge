import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruic-purge-pack-'));
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm.cmd' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', path.join(root, 'cache')], process.cwd()))[0];
  for (const required of ['lib/index.js', 'lib/patches.js', 'bin/ruic-dsh-purge.js', 'client.js', 'cordis.patch.yml', 'LICENSE', 'NOTICE.md']) {
    if (!packed.files.some(f => f.path === required)) throw new Error('Missing from package: ' + required);
  }
  run('tar', ['-xzf', path.join(root, packed.filename), '-C', root], process.cwd());
  const cwd = path.join(root, 'package');
  const version = run(process.execPath, ['bin/ruic-dsh-purge.js', '--version'], cwd).trim();
  const expected = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  if (version !== expected) throw new Error(`Packed CLI version mismatch: ${version} !== ${expected}`);
  run(process.execPath, ['--input-type=module', '-e', "import('./lib/index.js').then(m=>{if(m.name!=='ruic-dsh-purge')process.exit(1)})"], cwd);
  console.log(`Packed CLI and plugin import passed without dependencies (${packed.files.length} files).`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
