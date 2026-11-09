import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function withSkillLock(store, id, operation) {
  const directory = join(store.stateDir, 'locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.lock`);
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Этот скилл изменяется в другом окне. Повторите действие.'), { code: 'BUSY' });
    throw error;
  }
  try { return await operation(); }
  finally { await lock.close(); await unlink(path); }
}
