import test from 'node:test';
import assert from 'node:assert/strict';
import { AIError } from '../shared/protocol.js';
import { MonitorError } from '../../monitor/core.mjs';

test('website bridge diagnostics are bounded and preserve compatibility code', () => {
  const error = new AIError('MODEL_ERROR', 502, {
    operation: '/api/chat', cause: 'authorization=Bearer secret-value ' + 'x'.repeat(2000),
    details: { response_excerpt: 'token=secret-value' },
  });
  const payload = error.toJSON('request-1');
  assert.equal(payload.error_code, 'MODEL_ERROR');
  assert.equal(payload.correlation_id, 'request-1');
  assert.equal(payload.status_code, 502);
  assert.equal(payload.cause.includes('secret-value'), false);
  assert.ok(payload.cause.length <= 512);
});

test('monitor diagnostics retain retryability without raw provider body', () => {
  const error = new MonitorError('HTTP_429', {
    status: 429, retryAfter: 60, cause: 'secret=provider-value', operation: 'gmail.fetch', retryable: true,
  });
  const payload = error.toJSON('monitor-1');
  assert.equal(payload.error_code, 'HTTP_429');
  assert.equal(payload.retryable, true);
  assert.equal(payload.cause.includes('provider-value'), false);
  assert.equal(payload.correlation_id, 'monitor-1');
});
