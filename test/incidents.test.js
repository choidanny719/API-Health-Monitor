import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { validateMonitor } from '../src/validation.js';

const config = validateMonitor({ name: 'Catalog', url: 'https://example.com/health' });
const failed = { checkedAt: '2026-09-30T00:00:00.000Z', ok: false, statusCode: 503, durationMs: 10, failureCode: 'status_mismatch', message: 'Expected HTTP 200, received 503' };
const healthy = { ...failed, checkedAt: '2026-09-30T00:01:00.000Z', ok: true, statusCode: 200, failureCode: null, message: null };

test('three consecutive failures open one incident and recovery resets the streak', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  store.record(monitor, failed);
  store.record(monitor, healthy);
  store.record(monitor, failed);
  store.record(monitor, failed);
  assert.equal(store.get(monitor.id).status, 'up');
  assert.equal(store.incidents(monitor.id, 100).length, 0);
  store.record(monitor, failed);
  assert.equal(store.get(monitor.id).status, 'down');
  store.record(monitor, failed);
  assert.equal(store.incidents(monitor.id, 100).length, 1);
  store.record(monitor, healthy);
  assert.equal(store.get(monitor.id).status, 'up');
  assert.equal(store.get(monitor.id).consecutiveFailures, 0);
  assert.equal(store.incidents(monitor.id, 100)[0].resolution, 'recovered');
  assert.equal(store.incidents(monitor.id, 100)[0].resolvedAt, healthy.checkedAt);
});

test('editing a monitor closes an existing incident without claiming recovery', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  for (let i = 0; i < 3; i++) store.record(monitor, failed);
  store.update(monitor.id, { ...config, enabled: false });
  assert.equal(store.incidents(monitor.id, 100)[0].resolution, 'configuration_changed');
  assert.equal(store.get(monitor.id).status, 'pending');
  assert.equal(store.get(monitor.id).consecutiveFailures, 0);
});

test('failure streak and open incident survive a database restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(join(dir, 'test.db'));
  const monitor = first.create(config);
  first.record(monitor, failed);
  first.record(monitor, failed);
  first.close();
  const second = new Store(join(dir, 'test.db'));
  second.record(second.get(monitor.id), failed);
  second.close();
  const third = new Store(join(dir, 'test.db'));
  t.after(() => third.close());
  assert.equal(third.incidents(monitor.id, 100).length, 1);
  third.record(third.get(monitor.id), healthy);
  assert.equal(third.incidents(monitor.id, 100)[0].resolution, 'recovered');
});

test('a database failure rolls back the check and monitor state together', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  store.db.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON monitors BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  assert.throws(() => store.record(monitor, failed), /test failure/);
  assert.equal(store.checks(monitor.id, 100).length, 0);
  assert.equal(store.get(monitor.id).consecutiveFailures, 0);
});

test('an incident write failure rolls back the third check and its schedule', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  store.record(monitor, failed);
  store.record(monitor, failed);
  const before = store.get(monitor.id);
  const checks = store.checks(monitor.id, 100);
  store.db.exec(`CREATE TRIGGER fail_incident BEFORE INSERT ON incidents BEGIN SELECT RAISE(ABORT, 'incident failure'); END;`);
  assert.throws(() => store.record(monitor, failed, Date.now() + 60000), /incident failure/);
  assert.deepEqual(store.get(monitor.id), before);
  assert.deepEqual(store.checks(monitor.id, 100), checks);
  assert.deepEqual(store.incidents(monitor.id, 100), []);
});

test('incident retention keeps the latest 100 without affecting another monitor', t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  const other = store.create({ ...config, name: 'Search' });
  for (let i = 0; i < 3; i++) store.record(other, failed);
  const otherIncidents = store.incidents(other.id, 100);
  const incidents = [];
  for (let i = 0; i < 101; i++) {
    for (let j = 0; j < 3; j++) store.record(monitor, failed);
    if (i < 100) store.record(monitor, healthy);
    incidents.push(store.incidents(monitor.id, 1)[0]);
  }
  assert.deepEqual(store.incidents(monitor.id, 100), incidents.slice(-100).reverse());
  assert.equal(store.incidents(monitor.id, 1)[0].resolvedAt, null);
  assert.deepEqual(store.incidents(other.id, 100), otherIncidents);
});
