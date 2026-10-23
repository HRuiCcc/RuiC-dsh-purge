import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function homePath(options = {}) {
  return path.resolve(options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}
export async function resolveBase(options = {}) {
  const explicit = options.base || process.env.DSH_BASE;
  if (explicit) return fs.realpath(path.resolve(explicit));
  const prefixes = [path.dirname(path.dirname(process.execPath))];
  try {
    prefixes.push(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32',
    }).trim());
  } catch { /* Explicit --base remains available without npm. */ }
  const found = new Set();
  for (const prefix of prefixes.filter(Boolean)) {
    for (const dir of ['node_modules', path.join('lib', 'node_modules')]) {
      const candidate = path.join(prefix, dir, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
      try {
        await fs.access(path.join(candidate, 'dsh-agent-instructions', 'lib', 'index.js'));
        found.add(await fs.realpath(candidate));
      } catch { /* Try the next bounded installation location. */ }
    }
  }
  if (found.size !== 1) throw new Error(`Found ${found.size} DSH installations. Set --base or DSH_BASE to the @deepseek-ai directory.`);
  return [...found][0];
}
