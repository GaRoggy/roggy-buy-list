import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { acquireProcessLock } from '../shared/single-instance.mjs';

async function tempLock(t) {
  const directory = await mkdtemp(join(tmpdir(), 'layne-single-instance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'service.lock');
}

test('single instance permits one owner and rejects an active duplicate', async t => {
  const lockPath = await tempLock(t);
  const first = await acquireProcessLock(lockPath);
  t.after(() => first.release());
  await assert.rejects(() => acquireProcessLock(lockPath), error => error.code === 'DUPLICATE_INSTANCE');
  const payload = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(payload.pid, process.pid);
});

test('released lock can be acquired again', async t => {
  const lockPath = await tempLock(t);
  const first = await acquireProcessLock(lockPath);
  await first.release();
  const second = await acquireProcessLock(lockPath);
  t.after(() => second.release());
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
});

test('stale lock owned by an exited process is recovered', async t => {
  const lockPath = await tempLock(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  await writeFile(lockPath, JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }));
  const lock = await acquireProcessLock(lockPath);
  t.after(() => lock.release());
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
});

test('unreadable lock is preserved and not deleted', async t => {
  const lockPath = await tempLock(t);
  await writeFile(lockPath, 'not-json');
  await assert.rejects(() => acquireProcessLock(lockPath), error => error.code === 'LOCK_UNREADABLE');
  assert.equal(await readFile(lockPath, 'utf8'), 'not-json');
});

test('accepts a file URL lock path used by service entry points', async t => {
  const lockPath = await tempLock(t);
  const lock = await acquireProcessLock(pathToFileURL(lockPath));
  t.after(() => lock.release());
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
});
