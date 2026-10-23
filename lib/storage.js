import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export async function atomicWrite(file, data, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } finally {
    await handle?.close();
    await fs.rm(tmp, { force: true });
  }
}
export const writeJson = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export async function regular(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
  return st;
}
export async function withLock(root, action) {
  const file = path.join(root, '.ruic-dsh-purge.lock');
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Operation locked: ${file}. If the previous process crashed, verify it has stopped before removing this lock.`);
    throw e;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(file);
  }
}
