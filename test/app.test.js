import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
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

test('rejects foreign hostnames and browser origins', async t => {
  const base = await serve(t, createApp());
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/health`, { headers: { host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { origin: base } })).status, 200);
});
