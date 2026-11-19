import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createLocalOwnerManagerServer } from '../../scripts/local-owner-manager.mjs';

async function startFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'laynegarmin-owner-manager-'));
  await writeFile(path.join(root, 'index.html'), '<title>Owner manager fixture</title>');
  await writeFile(path.join(root, 'app.js'), 'window.fixture = true;');
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  const server = await createLocalOwnerManagerServer({ root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const expectedPrefix = path.join(os.tmpdir(), 'laynegarmin-owner-manager-');
    assert.ok(path.resolve(root).startsWith(path.resolve(expectedPrefix)));
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('local owner manager is loopback-only, allowlisted, and does not expose repository files', async t => {
  const fixture = await startFixture(t);
  assert.equal(fixture.server.address().address, '127.0.0.1');
  const home = await fetch(fixture.base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(await home.text(), '<title>Owner manager fixture</title>');
  const app = await fetch(fixture.base + '/app.js?v=1');
  assert.equal(app.status, 200);
  assert.equal(await app.text(), 'window.fixture = true;');
  assert.equal((await fetch(fixture.base + '/package.json')).status, 404);
  assert.equal((await fetch(fixture.base + '/logs/smart_home.log')).status, 404);
  assert.equal((await fetch(fixture.base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(fixture.base + '/', { method: 'POST' })).status, 405);
});

test('OAuth callback returns the code to the local app root without logging or echoing it', async t => {
  const fixture = await startFixture(t);
  const response = await fetch(fixture.base + '/roggy/callback?code=fixture-code&state=fixture-state', { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?code=fixture-code&state=fixture-state');
  assert.equal(await response.text(), '');
});

test('owner auth redirects locally only to the existing allowlisted callback', async () => {
  const helper = await readFile(new URL('../../owner-auth-redirect.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../app.js', import.meta.url), 'utf8');
  const index = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const context = { window: { location: { protocol: 'http:', hostname: '127.0.0.1', port: '8766', origin: 'http://127.0.0.1:8766' } } };
  vm.runInNewContext(helper, context);
  assert.equal(context.window.roggyOwnerAuthRedirectTo(), 'http://127.0.0.1:8766/roggy/callback');
  context.window.location = { protocol: 'https:', hostname: 'garoggy.github.io', port: '', origin: 'https://garoggy.github.io' };
  assert.equal(context.window.roggyOwnerAuthRedirectTo(), 'https://garoggy.github.io/roggy-buy-list/');
  assert.match(app, /redirectTo:window\.roggyOwnerAuthRedirectTo\(\)/);
  assert.ok(index.indexOf('owner-auth-redirect.js') < index.search(/src="app\.js\?v=\d+"/));
});
