import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const transcriptUi = await readFile(new URL('../../ai-ui.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('live transcript history cannot silently remain empty during stream startup or reconnect', () => {
  assert.match(transcriptUi, /transcriptHistoryState = 'idle'/);
  assert.match(transcriptUi, /scheduleTranscriptHistoryRetry/);
  assert.match(transcriptUi, /if \(!stream\) transcriptStatus\('Connecting transcript feed…', 'checking'\)/);
  assert.match(transcriptUi, /transcriptHistoryState = 'failed'/);
  assert.match(transcriptUi, /Transcript history unavailable/);
  assert.match(transcriptUi, /loadTranscriptHistory\(\)\.finally\(\(\) => refreshTranscriptHealth\(\)\)/);
  assert.match(transcriptUi, /Listening · transcript feed live/);
  const cacheVersion = Number(serviceWorker.match(/const CACHE='roggy-lists-v(\d+)'/)?.[1]);
  assert.ok(Number.isFinite(cacheVersion) && cacheVersion >= 83,
    'the service worker must use a cache-busted asset version at or beyond the transcript-feed fix');
  const aiUiVersion = index.match(/src="ai-ui\.js\?v=(\d+)"/)?.[1];
  assert.ok(aiUiVersion && serviceWorker.includes(`ai-ui.js?v=${aiUiVersion}`),
    "the service worker must precache the current index.html AI UI script");
});
