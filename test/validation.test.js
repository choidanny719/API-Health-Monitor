import assert from 'node:assert/strict';
import test from 'node:test';
import { historyLimit, validateMonitor } from '../src/validation.js';

const config = { name: 'Catalog', url: 'https://example.com/health' };

test('JSON expectations accept primitive values and boundary lengths', () => {
  for (const equals of [null, true, false, 0, -1.5, '', 'ready', 'x'.repeat(1000)]) {
    const expectedJson = { path: 'data.items.0.is_ready-v2', equals };
    assert.deepEqual(validateMonitor({ ...config, expectedJson }).expectedJson, expectedJson);
  }
  const expectedJson = { path: 'x'.repeat(200), equals: true };
  const current = validateMonitor({ ...config, expectedJson });
  assert.deepEqual(current.expectedJson, expectedJson);
  assert.deepEqual(validateMonitor({ name: 'Renamed' }, current).expectedJson, expectedJson);
  assert.equal(validateMonitor({ expectedJson: null }, current).expectedJson, null);
});

test('invalid JSON expectations keep the same validation error', () => {
  const invalid = [
    undefined, false, 0, '', [], {}, { path: 'ready' }, { equals: true },
    { path: 'ready', equals: true, extra: true },
    ...['', '.ready', 'ready.', 'data..ready', 'data[0]', 'x'.repeat(201),
      '__proto__', 'data.prototype.ready', 'data.constructor', 1, null]
      .map(path => ({ path, equals: true })),
    ...[undefined, {}, [], NaN, Infinity, -Infinity, 'x'.repeat(1001)]
      .map(equals => ({ path: 'ready', equals }))
  ];
  for (const expectedJson of invalid) {
    assert.throws(() => validateMonitor({ ...config, expectedJson }), {
      status: 400,
      message: 'expectedJson must contain a dot-separated path and a primitive equals value'
    });
  }
});

test('numeric monitor fields accept their limits and reject invalid numbers or types', () => {
  const cases = [
    ['intervalSeconds', [10, 86400], [9, 86401]],
    ['timeoutMs', [100, 30000], [99, 30001]],
    ['expectedStatus', [200, 299, 400, 599], [199, 300, 399, 600]],
    ['maxResponseMs', [1, 5000, null], [0, 5001]]
  ];
  for (const [field, valid, invalid] of cases) {
    for (const value of valid) {
      assert.equal(validateMonitor({ ...config, [field]: value })[field], value, `${field}=${value}`);
    }
    for (const value of [...invalid, ...(field === 'maxResponseMs' ? [] : [null]),
      undefined, 1.5, NaN, Infinity, -Infinity, '100', true, [], {}]) {
      assert.throws(() => validateMonitor({ ...config, [field]: value }), { status: 400 }, `${field}=${value}`);
    }
  }
});

test('timeouts and response thresholds cannot exceed their enclosing limits', () => {
  const valid = validateMonitor({ ...config, intervalSeconds: 10, timeoutMs: 10000, maxResponseMs: 10000 });
  assert.equal(valid.timeoutMs, 10000);
  assert.equal(valid.maxResponseMs, 10000);
  assert.throws(() => validateMonitor({ ...valid, timeoutMs: 10001 }), { status: 400 });
  assert.throws(() => validateMonitor({ ...valid, maxResponseMs: 10001 }), { status: 400 });
  assert.throws(() => validateMonitor({ timeoutMs: 9999 }, valid), { status: 400 });
  assert.equal(validateMonitor({ maxResponseMs: null }, valid).maxResponseMs, null);
});

test('names and URLs enforce their length boundaries and preserve valid values', () => {
  for (const name of ['a', 'x'.repeat(100)]) {
    assert.equal(validateMonitor({ ...config, name: ` ${name} ` }).name, name);
  }
  for (const name of ['', ' \t\n ', 'x'.repeat(101), null, 1, []]) {
    assert.throws(() => validateMonitor({ ...config, name }), { status: 400 });
  }
  const prefix = 'https://example.com/';
  const url = prefix + 'a'.repeat(2048 - prefix.length);
  assert.equal(validateMonitor({ ...config, url }).url, url);
  for (const value of [url + 'a', '', 'not a URL', null, 1, []]) {
    assert.throws(() => validateMonitor({ ...config, url: value }), { status: 400 });
  }
});

test('monitor bodies must be nonempty objects and enabled must be a boolean', () => {
  for (const body of [undefined, null, false, 1, 'name', [], {}]) {
    assert.throws(() => validateMonitor(body), { status: 400 });
  }
  for (const enabled of [true, false]) {
    assert.equal(validateMonitor({ ...config, enabled }).enabled, enabled);
  }
  for (const enabled of [null, 0, 1, 'false', [], {}]) {
    assert.throws(() => validateMonitor({ ...config, enabled }), { status: 400 });
  }
});

test('history limits accept defaults and endpoints but reject ambiguous inputs', () => {
  assert.equal(historyLimit(undefined), 50);
  assert.equal(historyLimit('1'), 1);
  assert.equal(historyLimit('100'), 100);
  for (const value of ['', '0', '101', '-1', '1.5', '1e2', ' 1', '1 ', '+1', 'abc',
    '99999999999999999999', null, 1, ['1', '2'], {}]) {
    assert.throws(() => historyLimit(value), { status: 400 });
  }
});
