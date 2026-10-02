import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { createDemoService } from '../src/demo-service.js';
import { createApp } from '../src/app.js';
import { serve, jsonRequest } from './helpers.js';

test('browser demo lists presets and runs only a selected fixed scenario', async t => {
  const store = new Store();
  const runner = new Runner(store, async () => { throw new Error('real monitor checker must not run'); });
  const base = await serve(t, createApp({ store, runner, demo: createDemoService(), publicDemo: true }));
  t.after(() => store.close());
  const scenarios = await jsonRequest(base, '/api/demo/scenarios');
  assert.equal(scenarios.status, 200);
  assert.equal(scenarios.body.scenarios.length, 4);
  const wrong = await jsonRequest(base, '/api/demo/run', 'POST', { scenario: 'wrong-json' });
  assert.equal(wrong.body.checks[0].statusCode, 200);
  assert.equal(wrong.body.checks[0].failureCode, 'json_mismatch');
  assert.equal(store.list().length, 0);
});

test('demo API rejects bad inputs, foreign origins and remote monitor access', async t => {
  const store = new Store();
  const runner = new Runner(store, async () => ({}));
  const base = await serve(t, createApp({ store, runner, demo: createDemoService(), publicDemo: true }));
  t.after(() => store.close());
  assert.equal((await jsonRequest(base, '/api/demo/run', 'POST', { scenario: 'https://example.org' })).status, 400);
  assert.equal((await jsonRequest(base, '/api/demo/run', 'POST', { scenario: 'healthy', url: 'http://127.0.0.1' })).status, 400);
  assert.equal((await fetch(`${base}/api/demo/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ scenario: 'healthy' })
  })).status, 403);
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/monitors`, { headers: { host: 'public.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('static dashboard and public demo API can be disabled', async t => {
  const store = new Store();
  const runner = new Runner(store, async () => ({}));
  const base = await serve(t, createApp({ store, runner, demo: createDemoService() }));
  t.after(() => store.close());
  assert.equal((await fetch(base)).status, 404);
  assert.equal((await fetch(`${base}/api/demo/scenarios`)).status, 404);
});
