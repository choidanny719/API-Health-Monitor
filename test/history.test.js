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

test('a retention failure rolls back the new check and health update', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(validateMonitor({ name: 'Catalog', url: 'https://example.com' }));
  for (let i = 0; i < 1000; i++) store.record(monitor, result, i);
  const before = store.get(monitor.id);
  const checks = store.checks(monitor.id, 1000);
  const failed = { ...result, ok: false, failureCode: 'timeout', message: 'Check stopped before completion' };
  store.db.exec(`CREATE TRIGGER fail_pruning BEFORE DELETE ON checks BEGIN SELECT RAISE(ABORT, 'pruning failed'); END;`);
  assert.throws(() => store.record(monitor, failed, 1000), /pruning failed/);
  assert.deepEqual(store.get(monitor.id), before);
  assert.deepEqual(store.checks(monitor.id, 1000), checks);
  store.db.exec('DROP TRIGGER fail_pruning');
  const saved = store.record(monitor, failed, 1000);
  assert.deepEqual(store.checks(monitor.id, 1000), [saved, ...checks.slice(0, 999)]);
  assert.equal(store.get(monitor.id).consecutiveFailures, 1);
});

test('deleting a monitor removes its checks and incidents while preserving other monitors', t => {
  const store = new Store();
  t.after(() => store.close());
  const config = validateMonitor({ name: 'Catalog', url: 'https://example.com' });
  const monitor = store.create(config);
  const other = store.create({ ...config, name: 'Search' });
  const failed = { ...result, ok: false, failureCode: 'timeout', message: 'Check stopped before completion' };
  for (const current of [monitor, other]) {
    for (let i = 0; i < 3; i++) store.record(current, failed);
  }
  const before = store.get(other.id);
  const checks = store.checks(other.id, 100);
  const incidents = store.incidents(other.id, 100);
  store.delete(monitor.id);
  assert.throws(() => store.get(monitor.id), { status: 404 });
  assert.throws(() => store.checks(monitor.id, 100), { status: 404 });
  assert.throws(() => store.incidents(monitor.id, 100), { status: 404 });
  assert.deepEqual(store.list(), [before]);
  assert.deepEqual(store.checks(other.id, 100), checks);
  assert.deepEqual(store.incidents(other.id, 100), incidents);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM checks').get().count, checks.length);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM incidents').get().count, incidents.length);
});
