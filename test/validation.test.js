import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMonitor } from '../src/validation.js';

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
