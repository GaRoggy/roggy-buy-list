import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../app.js', import.meta.url), 'utf8');
const pcHealth = await readFile(new URL('../../pc-health.js', import.meta.url), 'utf8');
const network = await readFile(new URL('../../network.js', import.meta.url), 'utf8');

test('camera status failure cannot re-enter the Home/Devices render loop', () => {
  assert.match(source, /function maybeLoadFrontDoorState\(\)\{[\s\S]*frontDoorStateAttempted\)return;/);
  assert.doesNotMatch(source, /if\(smartHomeControlAllowed&&!frontDoorState&&!frontDoorStateLoading\)loadFrontDoorState/);
  assert.match(source, /frontDoorStateRetryDelayMs=Math\.min\(delay\*2,60000\)/);
});

test('live dashboard reads have singleton request guards and bounded event refresh', () => {
  assert.match(pcHealth, /if \(homePromise\) return homePromise;/);
  assert.match(network, /if \(homePromise\) return homePromise;/);
  assert.match(pcHealth, /document\.addEventListener\("visibilitychange"/);
  assert.match(network, /document\.addEventListener\("visibilitychange"/);
  assert.match(pcHealth, /startRefresh\(\);\s*loadHome\(\)\.catch/);
  assert.match(network, /startRefresh\(\);\s*loadHomeNetworkCard\(\)\.catch/);
  assert.match(source, /if\(smartHomeRefreshTimer\)return;/);
  assert.match(source, /smartHomeStreamRetryDelayMs=Math\.min\(delay\*2,120000\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange",\(\)=>\{[\s\S]*loadSmartHome\(\{silent:true\}\)/);
  assert.match(source, /loadFrontDoorState\(\{silent:true,force:true\}\)/);
});
