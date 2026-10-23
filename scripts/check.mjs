import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const dir of ['lib', 'bin', 'scripts', 'test']) {
  for (const file of await fs.readdir(dir)) {
    if (!/\.[mc]?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
const client = spawnSync(process.execPath, ['--check', 'client.js'], { stdio: 'inherit' });
if (client.status) process.exit(client.status);
const pkg = JSON.parse(await fs.readFile('package.json'));
if (pkg.name !== 'ruic-dsh-purge') throw new Error('Unexpected package name');
if (!(await fs.readFile('cordis.patch.yml', 'utf8')).includes('name: ruic-dsh-purge')) throw new Error('Bundle identity mismatch');
console.log('Syntax and package identity checks passed.');
