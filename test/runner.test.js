import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { createChecker } from '../src/checker.js';
import { validateMonitor } from '../src/validation.js';
import { setImmediate as settle } from 'node:timers/promises';

const config = validateMonitor({ name: 'Catalog', url: 'https://example.com/health', intervalSeconds: 10 });
const healthy = { checkedAt: new Date().toISOString(), ok: true, statusCode: 200, durationMs: 1, failureCode: null, message: null };

test('scheduler obeys capacity, avoids overlap and waits until the next due time', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitors = Array.from({ length: 3 }, () => store.create(config, 1000));
  store.create({ ...config, enabled: false }, 1000);
  let now = 1000;
  const pending = [];
  const runner = new Runner(store, () => new Promise(resolve => pending.push(resolve)), { concurrency: 2, now: () => now });
  const first = runner.tick();
  assert.equal(pending.length, 2);
  await runner.tick();
  assert.equal(pending.length, 2);
  const runningId = [...runner.active.keys()][0];
  await assert.rejects(runner.run(runningId), { status: 409 });
  const waiting = monitors.find(monitor => !runner.active.has(monitor.id));
  await assert.rejects(runner.run(waiting.id), { status: 429 });
  pending.splice(0).forEach(resolve => resolve(healthy));
  await first;
  const second = runner.tick();
  assert.equal(pending.length, 1);
  pending.pop()(healthy);
  await second;
  await runner.tick();
  assert.equal(pending.length, 0);
  now += 10000;
  const third = runner.tick();
  assert.equal(pending.length, 2);
  pending.splice(0).forEach(resolve => resolve(healthy));
  await third;
  await runner.stop();
});

test('failed jobs release their slot and wait an interval before retrying', async t => {
  const store = new Store();
  t.after(() => store.close());
  store.create(config, 0);
  let calls = 0;
  const errors = [];
  const runner = new Runner(store, async () => { calls++; throw new Error('broken'); }, {
    now: () => 0, onError: error => errors.push(error.message)
  });
  await runner.tick();
  await runner.tick();
  assert.equal(calls, 1);
  assert.equal(runner.active.size, 0);
  assert.deepEqual(errors, ['broken']);
  await runner.stop();
});

test('shutdown cancels pending checks and does not record cancellation as downtime', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config);
  const checker = createChecker({ lookup: () => new Promise(() => {}) });
  const runner = new Runner(store, checker);
  const running = assert.rejects(runner.run(monitor.id), { status: 409 });
  await runner.stop();
  await running;
  assert.equal(store.checks(monitor.id, 100).length, 0);
  await assert.rejects(runner.run(monitor.id), { status: 503 });
});

test('scheduled retries wait a full interval after a checker exception', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config, 0);
  let now = 0;
  let calls = 0;
  const failure = new Error('Unavailable transport');
  const errors = [];
  const runner = new Runner(store, async () => {
    if (++calls === 1) throw failure;
    return healthy;
  }, { now: () => now, onError: error => errors.push(error) });
  await runner.tick();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  assert.equal(store.get(monitor.id).consecutiveFailures, 0);
  assert.equal(store.get(monitor.id).nextCheckAt, new Date(10000).toISOString());
  now = 9999;
  await runner.tick();
  assert.equal(calls, 1);
  now = 10000;
  await runner.tick();
  assert.equal(calls, 2);
  assert.equal(store.get(monitor.id).status, 'up');
  assert.equal(store.checks(monitor.id, 100).length, 1);
  assert.equal(runner.active.size, 0);
  await runner.stop();
});

test('a failed check from an older revision cannot defer the updated monitor', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config, 0);
  const pending = Promise.withResolvers();
  const failure = new Error('Old transport failed');
  const runner = new Runner(store, () => pending.promise, { now: () => 5000 });
  const running = assert.rejects(runner.run(monitor.id), failure);
  const updated = store.update(monitor.id, { ...config, intervalSeconds: 120 }, 1000);
  pending.reject(failure);
  await running;
  assert.deepEqual(store.get(monitor.id), updated);
  assert.deepEqual(store.due(1000).map(({ id }) => id), [monitor.id]);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  assert.equal(runner.active.size, 0);
  await runner.stop();
});

test('a scheduler tick continues other checks when one checker fails', async t => {
  const store = new Store();
  t.after(() => store.close());
  const failing = store.create(config, 0);
  const succeeding = store.create({ ...config, name: 'Search' }, 1);
  const errors = [];
  const failure = new Error('Catalog failed');
  const runner = new Runner(store, async monitor => {
    if (monitor.id === failing.id) throw failure;
    return healthy;
  }, { now: () => 1, onError: error => errors.push(error) });
  await runner.tick();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(store.checks(failing.id, 100), []);
  assert.equal(store.checks(succeeding.id, 100).length, 1);
  assert.equal(store.get(succeeding.id).status, 'up');
  assert.equal(runner.active.size, 0);
  await runner.stop();
});

test('stale scheduled results release their slots without reporting an internal error', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config, 0);
  const pending = Promise.withResolvers();
  const errors = [];
  const runner = new Runner(store, () => pending.promise, { now: () => 0, onError: error => errors.push(error) });
  const ticking = runner.tick();
  const updated = store.update(monitor.id, { ...config, enabled: false }, 1000);
  pending.resolve(healthy);
  await ticking;
  assert.deepEqual(errors, []);
  assert.deepEqual(store.get(monitor.id), updated);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  assert.equal(runner.active.size, 0);
  await runner.stop();
});

test('stopping an idle runner is repeatable and prevents future scheduling', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(config, 0);
  const runner = new Runner(store, async () => assert.fail('Stopped runner started a check'), { now: () => 0 });
  await runner.stop();
  await runner.stop();
  runner.start();
  await runner.tick();
  assert.equal(runner.timer, null);
  assert.equal(runner.active.size, 0);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  await assert.rejects(runner.run(monitor.id), { status: 503, message: 'Checker is stopping' });
});

test('starting twice creates one polling timer and shutdown prevents later checks', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new Store();
  const monitor = store.create(config, 0);
  let now = 0;
  let calls = 0;
  const errors = [];
  const runner = new Runner(store, async () => { calls++; return healthy; }, {
    now: () => now, onError: error => errors.push(error)
  });
  t.after(async () => { await runner.stop(); store.close(); });
  runner.start();
  const timer = runner.timer;
  runner.start();
  await settle();
  assert.equal(runner.timer, timer);
  assert.equal(calls, 1);
  assert.equal(store.checks(monitor.id, 100).length, 1);
  now = 9999;
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(calls, 1);
  now = 10000;
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls, 2);
  assert.equal(store.checks(monitor.id, 100).length, 2);
  await runner.stop();
  now = 20000;
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(errors, []);
});

test('a failed polling query is reported once and the next timer tick recovers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new Store();
  const monitor = store.create(config, 0);
  const failure = new Error('Due query failed');
  const due = t.mock.method(store, 'due', () => { throw failure; });
  const errors = [];
  const runner = new Runner(store, async () => healthy, { now: () => 0, onError: error => errors.push(error) });
  t.after(async () => { await runner.stop(); store.close(); });
  runner.start();
  await settle();
  assert.deepEqual(errors, [failure]);
  assert.equal(runner.active.size, 0);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  due.mock.restore();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(errors, [failure]);
  assert.equal(store.get(monitor.id).status, 'up');
  assert.equal(store.checks(monitor.id, 100).length, 1);
});

test('shutdown waits for every active task and discards late successful results', async t => {
  const store = new Store();
  const monitors = [store.create(config, 0), store.create(config, 1)];
  const pending = monitors.map(() => Promise.withResolvers());
  let calls = 0;
  const runner = new Runner(store, () => pending[calls++].promise, { now: () => 1000 });
  t.after(async () => {
    pending.forEach(task => task.resolve(healthy));
    await runner.stop();
    store.close();
  });
  const failure = new Error('Late transport failure');
  const first = assert.rejects(runner.run(monitors[0].id), { status: 409 });
  const second = assert.rejects(runner.run(monitors[1].id), failure);
  let stopped = false;
  const stopping = runner.stop().then(() => { stopped = true; });
  assert.equal(runner.controller.signal.aborted, true);
  await assert.rejects(runner.run(monitors[0].id), { status: 503 });
  await settle();
  assert.equal(stopped, false);
  pending[0].resolve(healthy);
  await first;
  assert.equal(stopped, false);
  assert.equal(runner.active.size, 1);
  pending[1].reject(failure);
  await Promise.all([second, stopping]);
  assert.equal(stopped, true);
  assert.equal(runner.active.size, 0);
  for (const monitor of monitors) {
    assert.equal(store.get(monitor.id).status, 'pending');
    assert.deepEqual(store.checks(monitor.id, 100), []);
    assert.deepEqual(store.incidents(monitor.id, 100), []);
  }
});

test('scheduled checks start in due-time order and paused monitors do not use capacity', async t => {
  const store = new Store();
  const later = store.create(config, 2000);
  const early = store.create(config, 1000);
  store.create({ ...config, enabled: false }, 0);
  const sameTime = store.create(config, 1000);
  const started = [];
  const runner = new Runner(store, async monitor => {
    started.push(monitor.id);
    return healthy;
  }, { concurrency: 1, now: () => 2000 });
  t.after(async () => { await runner.stop(); store.close(); });
  const expected = [early.id, sameTime.id].sort().concat(later.id);
  for (let count = 1; count <= expected.length; count++) {
    await runner.tick();
    assert.deepEqual(started, expected.slice(0, count));
  }
  await runner.tick();
  assert.deepEqual(started, expected);
});
