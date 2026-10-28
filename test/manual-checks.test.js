import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createChecker } from '../src/checker.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import { validateMonitor } from '../src/validation.js';
import { serve, jsonRequest } from './helpers.js';

const config = validateMonitor({ name: 'Catalog', url: 'https://example.com/health' });
const healthy = { statusCode: 200, body: '{"ready":true}' };

async function setup(t, request) {
  const store = new Store();
  const checker = createChecker({
    lookup: async () => [{ address: '93.184.215.14', family: 4 }], request
  });
  const runner = new Runner(store, checker);
  t.after(async () => {
    await runner.stop();
    store.close();
  });
  const base = await serve(t, createApp({ store, runner }));
  return { base, store, runner };
}

test('paused monitors allow manual checks without becoming scheduled', async t => {
  const { base, store, runner } = await setup(t, async () => healthy);
  const monitor = store.create({ ...config, enabled: false });
  const path = `/monitors/${monitor.id}`;
  await runner.tick();
  assert.deepEqual(store.checks(monitor.id, 100), []);
  const checked = await jsonRequest(base, `${path}/check`, 'POST');
  assert.equal(checked.status, 201);
  assert.equal(checked.body.ok, true);
  assert.equal(checked.body.monitorId, monitor.id);
  assert.equal(checked.body.revision, 1);
  assert.deepEqual(await jsonRequest(base, `${path}/checks`), { status: 200, body: [checked.body] });
  const updated = (await jsonRequest(base, path)).body;
  assert.equal(updated.enabled, false);
  assert.equal(updated.status, 'up');
  assert.deepEqual(store.due(Date.parse(updated.nextCheckAt)), []);
});

test('manual checks return duplicate and capacity errors and reuse released slots', { timeout: 5000 }, async t => {
  const entered = Array.from({ length: 5 }, () => Promise.withResolvers());
  const pending = Array.from({ length: 5 }, () => Promise.withResolvers());
  let calls = 0;
  const { base, store, runner } = await setup(t, () => {
    const index = calls++;
    entered[index].resolve();
    return pending[index].promise;
  });
  const monitors = Array.from({ length: 5 }, () => store.create(config));
  const path = monitor => `/monitors/${monitor.id}/check`;
  const running = [];
  for (let i = 0; i < 4; i++) {
    running.push(jsonRequest(base, path(monitors[i]), 'POST'));
    await entered[i].promise;
  }
  assert.deepEqual(await jsonRequest(base, path(monitors[0]), 'POST'), {
    status: 409, body: { error: 'A check is already running for this monitor' }
  });
  assert.deepEqual(await jsonRequest(base, path(monitors[4]), 'POST'), {
    status: 429, body: { error: 'All checker slots are busy; try again shortly' }
  });
  assert.equal(calls, 4);
  for (const monitor of monitors) assert.deepEqual(store.checks(monitor.id, 100), []);
  pending[0].resolve(healthy);
  assert.equal((await running[0]).status, 201);
  running.push(jsonRequest(base, path(monitors[4]), 'POST'));
  await entered[4].promise;
  pending.slice(1).forEach(task => task.resolve(healthy));
  for (const response of await Promise.all(running)) {
    assert.equal(response.status, 201);
    assert.equal(response.body.ok, true);
  }
  for (const monitor of monitors) assert.equal(store.checks(monitor.id, 100).length, 1);
  assert.equal(runner.active.size, 0);
});

test('editing, pausing or deleting a monitor discards its running check', { timeout: 5000 }, async t => {
  for (const [name, method, body] of [
    ['editing', 'PATCH', { name: 'Updated', intervalSeconds: 120 }],
    ['pausing', 'PATCH', { enabled: false }],
    ['deleting', 'DELETE', undefined]
  ]) {
    await t.test(name, async t => {
      const entered = Promise.withResolvers();
      const pending = Promise.withResolvers();
      let calls = 0;
      const { base, store, runner } = await setup(t, () => {
        if (++calls > 1) return healthy;
        entered.resolve();
        return pending.promise;
      });
      const monitor = store.create(config);
      const path = `/monitors/${monitor.id}`;
      const running = jsonRequest(base, `${path}/check`, 'POST');
      await entered.promise;
      const changed = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(changed.status, method === 'DELETE' ? 204 : 200);
      const updated = method === 'DELETE' ? null : await changed.json();
      pending.resolve(healthy);
      assert.deepEqual(await running, {
        status: 409, body: { error: 'Check cancelled or monitor changed while it was running' }
      });
      assert.equal(runner.active.size, 0);
      if (updated) {
        assert.deepEqual(store.get(monitor.id), updated);
        assert.deepEqual(store.checks(monitor.id, 100), []);
        const checked = await jsonRequest(base, `${path}/check`, 'POST');
        assert.equal(checked.status, 201);
        assert.equal(checked.body.revision, 2);
        assert.equal(store.checks(monitor.id, 100).length, 1);
      } else {
        assert.equal((await jsonRequest(base, `${path}/check`, 'POST')).status, 404);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM checks').get().count, 0);
      }
    });
  }
});

test('internal recording errors are hidden from HTTP clients and release the checker slot', async t => {
  const { base, store, runner } = await setup(t, async () => healthy);
  const monitor = store.create(config);
  const record = t.mock.method(store, 'record', () => { throw new Error('SQL failure in private database path'); });
  const path = `/monitors/${monitor.id}/check`;
  assert.deepEqual(await jsonRequest(base, path, 'POST'), {
    status: 500, body: { error: 'Internal server error' }
  });
  assert.equal(runner.active.size, 0);
  assert.deepEqual(store.checks(monitor.id, 100), []);
  assert.equal(store.get(monitor.id).consecutiveFailures, 0);
  record.mock.restore();
  assert.equal((await jsonRequest(base, path, 'POST')).status, 201);
  assert.equal(store.checks(monitor.id, 100).length, 1);
});

test('network failures are saved as check results while missing and stopped monitors return HTTP errors', async t => {
  let calls = 0;
  const { base, store, runner } = await setup(t, async () => {
    calls++;
    throw new Error('Private connection details');
  });
  assert.deepEqual(await jsonRequest(base, '/monitors/missing/check', 'POST'), {
    status: 404, body: { error: 'Monitor not found' }
  });
  assert.equal(calls, 0);
  const monitor = store.create(config);
  const path = `/monitors/${monitor.id}/check`;
  const checked = await jsonRequest(base, path, 'POST');
  assert.equal(checked.status, 201);
  assert.equal(checked.body.ok, false);
  assert.equal(checked.body.failureCode, 'network_error');
  assert.equal(checked.body.message, 'Connection failed');
  assert.deepEqual(store.checks(monitor.id, 100), [checked.body]);
  await runner.stop();
  assert.deepEqual(await jsonRequest(base, path, 'POST'), {
    status: 503, body: { error: 'Internal server error' }
  });
  assert.equal(calls, 1);
  assert.deepEqual(store.checks(monitor.id, 100), [checked.body]);
});
