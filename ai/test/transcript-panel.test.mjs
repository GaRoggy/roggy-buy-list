import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const transcriptUi = await readFile(new URL('../../ai-ui.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');

test('live transcript history cannot silently remain empty during stream startup or reconnect', () => {
  assert.match(transcriptUi, /transcriptHistoryState = 'idle'/);
  assert.match(transcriptUi, /scheduleTranscriptHistoryRetry/);
  assert.match(transcriptUi, /if \(!stream\) transcriptStatus\('Connecting transcript feed…', 'checking'\)/);
  assert.match(transcriptUi, /transcriptHistoryState = 'failed'/);
  assert.match(transcriptUi, /Transcript history unavailable/);
  assert.match(transcriptUi, /loadTranscriptHistory\(\)\.finally\(\(\) => refreshTranscriptHealth\(\)\)/);
  assert.match(transcriptUi, /Listening · transcript feed live/);
  assert.match(serviceWorker, /const CACHE='roggy-lists-v83'/);
  assert.match(serviceWorker, /ai-ui\.js\?v=46/);
});
