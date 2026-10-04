import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { validateMonitor } from '../src/validation.js';
import { Runner } from '../src/runner.js';
import { serve, jsonRequest } from './helpers.js';

const result = { checkedAt: new Date().toISOString(), ok: true, statusCode: 200, durationMs: 5, failureCode: null, message: null };

test('manual checks save history, enforce limits and disappear with the monitor', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(validateMonitor({ name: 'Catalog', url: 'https://example.com' }));
  const runner = new Runner(store, async () => result);
  const base = await serve(t, createApp({ store, runner }));
  const path = `/monitors/${monitor.id}`;
  const checked = await jsonRequest(base, `${path}/check`, 'POST');
  assert.equal(checked.status, 201);
  assert.equal(checked.body.ok, true);
  assert.equal((await jsonRequest(base, `${path}/checks?limit=1`)).body.length, 1);
  assert.equal((await jsonRequest(base, `${path}/checks?limit=-1`)).status, 400);
  assert.equal((await jsonRequest(base, `${path}/checks?limit=101`)).status, 400);
  const other = store.create(validateMonitor({ name: 'Search', url: 'https://example.com/search' }));
  const otherCheck = store.record(other, result);
  const checks = [];
  for (let i = 0; i < 1005; i++) checks.push(store.record(monitor, result));
  assert.deepEqual(store.checks(monitor.id, 1000), checks.slice(-1000).reverse());
  assert.deepEqual(store.checks(other.id, 100), [otherCheck]);
  store.delete(monitor.id);
  assert.deepEqual(store.checks(other.id, 100), [otherCheck]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM checks').get().count, 1);
});

test('a completed check cannot overwrite a changed or deleted monitor', t => {
  const store = new Store();
  t.after(() => store.close());
  const config = validateMonitor({ name: 'Catalog', url: 'https://example.com' });
  const monitor = store.create(config);
  store.update(monitor.id, { ...config, name: 'Updated' });
  assert.equal(store.record(monitor, result), null);
  store.delete(monitor.id);
  assert.equal(store.record(monitor, result), null);
});

test('both history routes apply limits, preserve order and reject malformed parameters', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(validateMonitor({ name: 'Catalog', url: 'https://example.com' }));
  const failure = { ...result, ok: false, statusCode: 503, failureCode: 'status_mismatch', message: 'Unavailable' };
  for (let i = 0; i < 60; i++) {
    for (let j = 0; j < 3; j++) store.record(monitor, failure);
    store.record(monitor, result);
  }
  const base = await serve(t, createApp({ store }));
  for (const route of ['checks', 'incidents']) {
    const path = `/monitors/${monitor.id}/${route}`;
    const expected = store[route](monitor.id, 1000);
    for (const [query, limit] of [['', 50], ['?limit=1', 1], ['?limit=100', 100]]) {
      const response = await jsonRequest(base, path + query);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, expected.slice(0, limit));
    }
    for (const query of ['limit=', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1e2',
      'limit=%201', 'limit=abc', 'limit=1&limit=2']) {
      const response = await jsonRequest(base, `${path}?${query}`);
      assert.equal(response.status, 400, `${route}?${query}`);
      assert.equal(typeof response.body.error, 'string');
    }
    assert.equal((await jsonRequest(base, `/monitors/missing/${route}`)).status, 404);
  }
});
