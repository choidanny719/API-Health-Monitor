import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { createChecker } from '../src/checker.js';
import { validateMonitor } from '../src/validation.js';

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
