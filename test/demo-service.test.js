import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoService } from '../src/demo-service.js';

test('recovery scenario records a failure sequence, opens an incident and resolves it', async () => {
  const demo = createDemoService();
  const result = await demo.run('recovery');
  assert.deepEqual(result.checks.map(check => check.failureCode), [
    'status_mismatch', 'json_mismatch', 'timeout', null
  ]);
  assert.deepEqual(result.checks.map(check => check.status), ['pending', 'pending', 'down', 'up']);
  assert.deepEqual(result.checks.map(check => check.consecutiveFailures), [1, 2, 3, 0]);
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].resolution, 'recovered');
  assert.equal(result.monitor.name, 'Checkout API');
  assert.equal(result.monitor.status, 'up');
});

test('single check scenarios demonstrate JSON validation, response time and success', async () => {
  const demo = createDemoService();
  const wrongJson = await demo.run('wrong-json');
  assert.equal(wrongJson.checks[0].statusCode, 200);
  assert.equal(wrongJson.checks[0].failureCode, 'json_mismatch');
  const slow = await demo.run('slow-response');
  assert.equal(slow.checks[0].failureCode, 'slow_response');
  assert.ok(slow.checks[0].durationMs > 120);
  const healthy = await demo.run('healthy');
  assert.equal(healthy.checks[0].ok, true);
  assert.equal(healthy.monitor.status, 'up');
});

test('unknown scenario IDs are rejected', async () => {
  await assert.rejects(createDemoService().run('https://attacker.example'), {
    status: 400,
    message: 'Choose a listed demo scenario'
  });
});

test('simultaneous runs are bounded', async () => {
  const demo = createDemoService({ maxConcurrentRuns: 1 });
  const first = demo.run('recovery');
  await assert.rejects(demo.run('healthy'), { status: 429 });
  assert.equal((await first).monitor.status, 'up');
});
