import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptStore, formatTranscriptLine, formatTranscriptTime } from '../../transcript.js';

test('formats a finalized transcript line as a conversation row without microphone metadata', () => {
  const event = { timestamp: '2026-09-30T22:55:00.000Z', friendly_name: 'Living Room', room: 'living_room', microphone_id: 'mic-1', text: 'Layne, turn the lights off' };
  assert.equal(formatTranscriptTime(event.timestamp, { timeZone: 'America/Chicago' }), '5:55 PM');
  assert.equal(formatTranscriptLine(event, { timeZone: 'America/Chicago' }), '5:55 PM Me: "Layne, turn the lights off"');
});

test('renders Layne voice responses in the same chronological conversation stream', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:01:00Z') });
  store.ingest({ event_id: 'speech', timestamp: '2026-09-30T23:00:00Z', microphone_id: 'living-mic', friendly_name: 'Living Room', text: 'Layne, turn on the lights' });
  store.ingest({ event_id: 'reply', type: 'layne_voice_response', timestamp: '2026-09-30T23:00:01Z', microphone_id: 'living-mic', message: 'Done.' });
  assert.deepEqual(store.list().map(item => item.kind), ['user', 'assistant']);
  assert.equal(formatTranscriptLine(store.list()[1]), '6:00 PM Layne: "Done."');
});

test('keeps multiple microphones separate and supports filtering', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:00:00Z') });
  store.ingest({ event_id: 'a', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'living-mic', friendly_name: 'Living Room', text: 'Layne, turn on the lights' });
  store.ingest({ event_id: 'b', timestamp: '2026-09-30T22:59:30Z', microphone_id: 'kitchen-mic', friendly_name: 'Kitchen', text: 'Layne, what time is it?' });
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list('living-mic').map(item => item.event_id), ['a']);
  assert.deepEqual(store.list('kitchen-mic').map(item => item.event_id), ['b']);
});

test('deduplicates stable event ids while retaining repeated phrases with different ids', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:00:00Z') });
  const first = store.ingest({ event_id: 'one', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'mic', text: 'Layne, lights on', final: false });
  const updated = store.ingest({ event_id: 'one', timestamp: '2026-09-30T22:59:01Z', microphone_id: 'mic', text: 'Layne, lights on', final: true });
  store.ingest({ event_id: 'two', timestamp: '2026-09-30T22:59:02Z', microphone_id: 'mic', text: 'Layne, lights on', final: true });
  assert.equal(first.event_id, updated.event_id);
  assert.equal(updated.final, true);
  assert.equal(store.list().length, 2);
});

test('collapses cross-microphone raw events by logical utterance id', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:00:00Z') });
  store.ingest({ event_id: 'living-raw', logical_utterance_id: 'logical-1', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'living-mic', text: 'Layne, turn off the lights', also_heard_by: ['hallway-mic'] });
  store.ingest({ event_id: 'hallway-raw', logical_utterance_id: 'logical-1', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'hallway-mic', text: 'Turn off the lights' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].event_id, 'logical:logical-1');
  assert.equal(store.list()[0].raw_event_id, 'living-raw');
  assert.deepEqual(store.list()[0].also_heard_by, ['hallway-mic']);
});

test('collapses near-identical cross-microphone utterances within the short dedupe window', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:00:00Z') });
  store.ingest({ event_id: 'living-raw', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'living-mic', text: 'Lane, turn off the living room lights.' });
  store.ingest({ event_id: 'bedroom-raw', timestamp: '2026-09-30T22:59:02Z', microphone_id: 'bedroom-mic', text: 'Layne turn off the living room lights' });
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.list()[0].microphone_ids, ['living-mic', 'bedroom-mic']);
  assert.equal(formatTranscriptLine(store.list()[0]), '5:59 PM Me: "Layne, turn off the living room lights."');
  assert.equal(store.list('bedroom-mic').length, 1);
});

test('keeps different same-time speech separate and attaches duplicate Layne responses once', () => {
  const store = createTranscriptStore({ now: () => Date.parse('2026-09-30T23:00:00Z') });
  store.ingest({ event_id: 'speech-1', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'living-mic', text: 'Layne, turn off the lights' });
  store.ingest({ event_id: 'speech-2', timestamp: '2026-09-30T22:59:01Z', microphone_id: 'kitchen-mic', text: 'Layne, what time is it?' });
  store.ingest({ event_id: 'reply-1', transcript_event_id: 'speech-1', timestamp: '2026-09-30T22:59:03Z', microphone_id: 'living-mic', type: 'layne_voice_response', message: 'Done.' });
  store.ingest({ event_id: 'reply-2', transcript_event_id: 'speech-1', timestamp: '2026-09-30T22:59:03Z', microphone_id: 'bedroom-mic', type: 'layne_voice_response', message: 'Done.' });
  assert.deepEqual(store.list().map(item => item.kind), ['user', 'user', 'assistant']);
  assert.deepEqual(store.list('bedroom-mic').map(item => item.kind), ['assistant']);
  assert.equal(formatTranscriptLine(store.list()[2]), '5:59 PM Layne: "Done."');
});

test('normalizes Lane to Layne in visible display while retaining original diagnostics', () => {
  const store = createTranscriptStore();
  const entry = store.ingest({ event_id: 'spelling', timestamp: new Date().toISOString(), microphone_id: 'mic', original_transcript: 'Lane turn on the lights', normalized_transcript: 'Lane, turn on the lights', text: 'Lane turn on the lights' });
  assert.equal(entry.original_transcript, 'Lane turn on the lights');
  assert.match(formatTranscriptLine(entry), /Me: "Layne, turn on the lights"/);
});

test('prunes entries older than five minutes and remains bounded', () => {
  let now = Date.parse('2026-09-30T23:00:00Z');
  const store = createTranscriptStore({ now: () => now, maxEntries: 2 });
  store.ingest({ event_id: 'old', timestamp: '2026-09-30T22:54:59Z', microphone_id: 'mic', text: 'old' });
  store.ingest({ event_id: 'new-1', timestamp: '2026-09-30T22:59:00Z', microphone_id: 'mic', text: 'new one' });
  store.ingest({ event_id: 'new-2', timestamp: '2026-09-30T22:59:30Z', microphone_id: 'mic', text: 'new two' });
  assert.deepEqual(store.list().map(item => item.event_id), ['new-1', 'new-2']);
  now += 301_000;
  assert.equal(store.list().length, 0);
});

test('retains long transcript text without rendering HTML', () => {
  const store = createTranscriptStore();
  const text = '<script>alert(1)</script> ' + 'word '.repeat(500);
  store.ingest({ event_id: 'long', timestamp: new Date().toISOString(), microphone_id: 'mic', text });
  assert.equal(store.list()[0].text, text.trim());
  assert.match(formatTranscriptLine(store.list()[0]), /<script>alert\(1\)<\/script>/);
});
