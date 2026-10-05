import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function lockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ownerPid(payload) {
  if (!payload || !Number.isInteger(payload.pid) || payload.pid <= 0) return null;
  return payload.pid;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not inspectable. It is still active.
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function removeStaleLock(lockPath) {
  let payload;
  try {
    payload = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    // An unreadable lock is treated as active/unsafe. Never delete it blindly.
    throw lockError('LOCK_UNREADABLE', `Cannot validate lock ${lockPath}`);
  }
  const pid = ownerPid(payload);
  if (!pid) throw lockError('LOCK_UNREADABLE', `Invalid lock owner in ${lockPath}`);
  if (processIsAlive(pid)) throw lockError('DUPLICATE_INSTANCE', `Active lock owner ${pid}`);
  try {
    await unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Acquire a process-lifetime lock. The returned handle must be released on shutdown. */
export async function acquireProcessLock(lockPath) {
  const resolvedPath = lockPath instanceof URL ? fileURLToPath(lockPath) : lockPath;
  await mkdir(dirname(resolvedPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(resolvedPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await handle.close();
          try { await unlink(resolvedPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt !== 0) throw error?.code === 'EEXIST'
        ? lockError('DUPLICATE_INSTANCE', `Lock already exists: ${resolvedPath}`) : error;
      await removeStaleLock(resolvedPath);
    }
  }
  throw lockError('DUPLICATE_INSTANCE', `Unable to acquire ${resolvedPath}`);
}
