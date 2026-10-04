import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
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

test('accepts a 16 KiB JSON request and rejects one extra byte without writing data', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const config = JSON.stringify({ name: 'Catalog é', url: 'https://example.com/health' });
  const exact = config + ' '.repeat(16384 - Buffer.byteLength(config));
  assert.equal(Buffer.byteLength(exact), 16384);
  for (const [body, status] of [[exact, 201], [exact + ' ', 413]]) {
    const response = await fetch(`${base}/monitors`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    assert.equal(response.status, status);
    const result = await response.json();
    if (status === 201) assert.equal(result.name, 'Catalog é');
    else assert.equal(typeof result.error, 'string');
    assert.equal(store.list().length, 1);
  }
});
