import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { serve, jsonRequest } from './helpers.js';

test('health endpoint responds and unknown routes return JSON', async t => {
  const base = await serve(t, createApp());
  assert.deepEqual(await jsonRequest(base, '/health'), { status: 200, body: { status: 'ok' } });
  assert.deepEqual(await jsonRequest(base, '/missing'), {
    status: 404,
    body: { error: 'Route not found' }
  });
});

test('malformed JSON returns a client error', async t => {
  const base = await serve(t, createApp());
  const response = await fetch(`${base}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(response.status, 400);
  assert.equal(typeof (await response.json()).error, 'string');
});
