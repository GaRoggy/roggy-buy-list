import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chartSeries, gamingAssessment, networkHealthState } from '../../network-model.mjs';

const source = async name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');

test('network health model fails closed for stale or unavailable monitor data', () => {
  assert.equal(networkHealthState({ status: 'RUNNING', stale: false, classification: 'NORMAL' }), 'healthy');
  assert.equal(networkHealthState({ status: 'RUNNING', stale: false, classification: 'DEGRADED' }), 'degraded');
  assert.equal(networkHealthState({ status: 'RUNNING', stale: false, classification: 'LOCAL_NETWORK_OR_ROUTER_FAILURE', gateway: { online: false }, internet: { online: false } }), 'offline');
  assert.equal(networkHealthState({ status: 'STALE', stale: true, classification: 'NORMAL' }), 'unknown');
  assert.equal(networkHealthState({ status: 'MONITOR_UNAVAILABLE', stale: true }), 'unknown');
});

test('chart transform keeps bounded order and missing measurements as gaps', () => {
  const series = chartSeries({ measurements: [
    { timestamp: '2026-10-05T04:00:00Z', latency_ms: 20, jitter_ms: null, packet_loss_pct: 0 },
    { timestamp: '2026-10-05T04:01:00Z', latency_ms: null, jitter_ms: 8, packet_loss_pct: 33.3 },
  ] }, 'latency');
  assert.deepEqual(series.labels, ['2026-10-05T04:00:00Z', '2026-10-05T04:01:00Z']);
  assert.deepEqual(series.values, [20, null]);
  assert.deepEqual(chartSeries({ measurements: [{ timestamp: 'x', packet_loss_pct: 2.5 }] }, 'loss').values, [2.5]);
});

test('gaming view is an evidence-based heuristic without a synthetic score', () => {
  const good = gamingAssessment({ current_latency_ms: 25, current_jitter_ms: 3, packet_loss_5m_pct: 0 }, {});
  const poor = gamingAssessment({ current_latency_ms: 140, current_jitter_ms: 40, packet_loss_5m_pct: 4 }, {});
  assert.equal(good.state, 'good');
  assert.equal(poor.state, 'poor');
  assert.equal(Object.hasOwn(good, 'score'), false);
});

test('network page is statically shipped, mobile-safe, and never exposes local paths', async () => {
  const [html, script, css, files, bridge] = await Promise.all([
    source('index.html'), source('network.js'), source('network.css'), source('scripts/static-files.mjs'), source('ai/bridge/server.mjs'),
  ]);
  for (const id of ['homeNetworkCard', 'networkPage', 'networkStatusCard', 'networkChart', 'networkIncidentList', 'networkGamingCard']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /networkFetch\("\/network\/status"\)/);
  assert.match(script, /data-network-prompt/);
  assert.match(css, /@media \(max-width:620px\)/);
  assert.match(files, /network\.js/);
  assert.match(files, /network-model\.mjs/);
  assert.match(files, /network\.css/);
  assert.match(bridge, /network_get_measurements/);
  assert.doesNotMatch(script, /C:\\Codex|snapshot_path|database\.db|SUPABASE_SERVICE_ROLE/);
});
