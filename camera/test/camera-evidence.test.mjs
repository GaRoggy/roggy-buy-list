import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hasVerifiedCameraPerson } from '../../supabase/functions/push-notifications/camera-evidence.ts';

const source = await readFile(new URL('../../front-door-evidence.js', import.meta.url), 'utf8');
const context = { module: { exports: {} }, Date, Number, Array };
vm.runInNewContext(source, context);
const { hasVerifiedPerson, shouldIncludeLocalEvent } = context.module.exports;

const file = 'front_door_20261123_230000_000000.jpg';
const stamp = '2026-11-24T05:00:00.000Z';
const valid = {
  person_verified: true,
  detection_evidence: {
    verified: true,
    detector_id: 'ssd-mobilenetv1-12',
    frame_id: file,
    frame_timestamp: stamp,
    verification_method: 'temporal_2_of_3',
    supporting_frames: 2,
    boxes: [{ class: 'person', confidence: 0.72, box: [0.2, 0.1, 0.65, 0.95] }],
  },
};

test('accepts frame-bound temporally verified person evidence', () => {
  assert.equal(hasVerifiedPerson(valid, file, stamp), true);
  assert.equal(hasVerifiedCameraPerson(valid, file, stamp), true);
  assert.equal(shouldIncludeLocalEvent('camera.person_event', valid, file, stamp), true);
});

test('rejects motion-only, manual, and analysis-error events', () => {
  assert.equal(shouldIncludeLocalEvent('camera.motion_detected', valid, file, stamp), false);
  assert.equal(shouldIncludeLocalEvent('camera.analysis_completed', valid, file, stamp), false);
  assert.equal(hasVerifiedPerson({ ...valid, person_verified: false }, file, stamp), false);
  assert.equal(hasVerifiedPerson({ ...valid, detection_evidence: { ...valid.detection_evidence, verified: false } }, file, stamp), false);
});

test('rejects evidence when the image or timestamp does not match', () => {
  assert.equal(hasVerifiedPerson(valid, 'front_door_other.jpg', stamp), false);
  assert.equal(hasVerifiedPerson(valid, file, '2026-11-24T05:00:02.000Z'), false);
  assert.equal(hasVerifiedCameraPerson(valid, 'front_door_other.jpg', stamp), false);
  assert.equal(hasVerifiedCameraPerson(valid, file, '2026-11-24T05:00:02.000Z'), false);
});

test('rejects non-person, weak, malformed, or unverified boxes', () => {
  for (const box of [
    { class: 'cat', confidence: 0.99, box: [0.1, 0.1, 0.9, 0.9] },
    { class: 'person', confidence: 0.2, box: [0.1, 0.1, 0.9, 0.9] },
    { class: 'person', confidence: 0.9, box: [0.1, 0.1, 1.4, 0.9] },
    { class: 'person', confidence: 0.9, box: [0.3, 0.2, 0.2, 0.9] },
  ]) {
    const value = { ...valid, detection_evidence: { ...valid.detection_evidence, boxes: [box] } };
    assert.equal(hasVerifiedPerson(value, file, stamp), false);
  }
  const unverified = { ...valid, detection_evidence: {
    ...valid.detection_evidence, verification_method: 'single_medium', supporting_frames: 1,
  } };
  assert.equal(hasVerifiedPerson(unverified, file, stamp), false);
});

test('accepts a very high single-frame person score only at the higher threshold', () => {
  const value = { ...valid, detection_evidence: {
    ...valid.detection_evidence,
    verification_method: 'high_confidence_single',
    supporting_frames: 1,
    boxes: [{ class: 'person', confidence: 0.94, box: [0.2, 0.1, 0.65, 0.95] }],
  } };
  assert.equal(hasVerifiedPerson(value, file, stamp), true);
});
