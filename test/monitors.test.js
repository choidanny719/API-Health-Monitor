import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { validateMonitor } from '../src/validation.js';
import { serve, jsonRequest } from './helpers.js';

const config = { name: 'Catalog', url: 'https://example.com/health' };

test('monitors can be created, listed, updated, paused and deleted through HTTP', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const created = await jsonRequest(base, '/monitors', 'POST', config);
  assert.equal(created.status, 201);
  assert.equal(created.body.intervalSeconds, 60);
  assert.equal(created.body.status, 'pending');
  const path = `/monitors/${created.body.id}`;
  assert.equal((await jsonRequest(base, '/monitors')).body.length, 1);
  const updated = await jsonRequest(base, path, 'PATCH', { enabled: false, name: 'Paused' });
  assert.equal(updated.body.enabled, false);
  assert.equal(updated.body.url, config.url);
  assert.equal(updated.body.revision, 2);
  assert.equal((await fetch(`${base}${path}`, { method: 'DELETE' })).status, 204);
  assert.equal((await jsonRequest(base, path)).status, 404);
  assert.deepEqual((await jsonRequest(base, '/monitors')).body, []);
});

test('monitor configuration survives closing and reopening the database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(join(dir, 'test.db'));
  const monitor = first.create(validateMonitor(config));
  first.close();
  const reopened = new Store(join(dir, 'test.db'));
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get(monitor.id), monitor);
});

test('invalid monitor configurations return 400 without writing data', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const invalid = [
    { name: '' }, { intervalSeconds: 0 }, { timeoutMs: 60000 }, { enabled: 'yes' },
    { expectedStatus: 302 }, { unknown: true }, { maxResponseMs: -1 },
    { expectedJson: { path: 'status' } }, { expectedJson: { path: 'constructor', equals: true } }
  ];
  for (const patch of invalid) {
    assert.equal((await jsonRequest(base, '/monitors', 'POST', { ...config, ...patch })).status, 400);
  }
  assert.equal(store.list().length, 0);
});

test('URL validation blocks local, reserved, encoded and credential-bearing targets', () => {
  for (const url of [
    'file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/',
    'http://0x7f000001/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://192.168.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/',
    'http://user:secret@example.com/', 'http://example.com/#part', 'http://service.local/'
  ]) assert.throws(() => validateMonitor({ ...config, url }), { status: 400 }, url);
  assert.equal(validateMonitor({ ...config, url: 'https://1.1.1.1/' }).url, 'https://1.1.1.1/');
});

test('rejects numeric expectations that would change when saved as JSON', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const response = await fetch(`${base}/monitors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"Catalog","url":"https://example.com","expectedJson":{"path":"price","equals":1e999}}'
  });
  assert.equal(response.status, 400);
  assert.equal(store.list().length, 0);
});

test('accepts 100 monitors, rejects the next one and reuses capacity after deletion', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const ids = [];
  for (let i = 0; i < 100; i++) {
    const response = await jsonRequest(base, '/monitors', 'POST', { ...config, name: `Monitor ${i}` });
    assert.equal(response.status, 201);
    ids.push(response.body.id);
  }
  const before = store.list();
  const rejected = await jsonRequest(base, '/monitors', 'POST', config);
  assert.deepEqual(rejected, { status: 409, body: { error: 'The limit is 100 monitors' } });
  assert.deepEqual(store.list(), before);
  const updated = await jsonRequest(base, `/monitors/${ids[0]}`, 'PATCH', { name: 'Renamed at capacity' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Renamed at capacity');
  assert.equal((await fetch(`${base}/monitors/${ids[0]}`, { method: 'DELETE' })).status, 204);
  const replacement = await jsonRequest(base, '/monitors', 'POST', config);
  assert.equal(replacement.status, 201);
  assert.equal(store.list().length, 100);
  assert.ok(!ids.includes(replacement.body.id));
});

test('rejects invalid updates without changing configuration, revision or history', async t => {
  const store = new Store();
  t.after(() => store.close());
  const monitor = store.create(validateMonitor(config));
  const before = store.get(monitor.id);
  const base = await serve(t, createApp({ store }));
  for (const patch of [{}, { name: ' ' }, { intervalSeconds: 10, timeoutMs: 10001 },
    { timeoutMs: 100, maxResponseMs: 101 }, { unknown: true }]) {
    const response = await jsonRequest(base, `/monitors/${monitor.id}`, 'PATCH', patch);
    assert.equal(response.status, 400);
    assert.deepEqual(store.get(monitor.id), before);
    assert.deepEqual(store.checks(monitor.id, 100), []);
  }
});
