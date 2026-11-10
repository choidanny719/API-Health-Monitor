import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { serve, jsonRequest, rawRequest } from './helpers.js';

test('health endpoint responds and unknown routes return JSON', async t => {
  const base = await serve(t, createApp());
  assert.deepEqual(await jsonRequest(base, '/health'), { status: 200, body: { status: 'ok' } });
  assert.deepEqual(await jsonRequest(base, '/missing'), {
    status: 404,
    body: { error: 'Route not found' }
  });
});

test('malformed JSON returns a client error', async t => {
  const base = await serve(t, createApp());
  const response = await fetch(`${base}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(response.status, 400);
  assert.equal(typeof (await response.json()).error, 'string');
});

test('rejects foreign hostnames and browser origins', async t => {
  const base = await serve(t, createApp());
  const response = await rawRequest(base, '/health', { headers: { host: 'attacker.example' } });
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { origin: base } })).status, 200);
});

test('local hostnames accept matching origins and ignore forwarded host headers', async t => {
  const base = await serve(t, createApp());
  const port = new URL(base).port;
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    const host = `${hostname}:${port}`;
    const response = await rawRequest(base, '/health', {
      headers: { host, origin: `http://${host}`, 'x-forwarded-host': 'attacker.example' }
    });
    assert.equal(response.status, 200, host);
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
    assert.equal(response.headers['x-powered-by'], undefined);
  }
});

test('foreign hosts cannot create monitors by supplying a local forwarded host', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const create = t.mock.method(store, 'create', () => assert.fail('Rejected request reached the store'));
  for (const host of ['attacker.example', 'localhost.attacker.example', '127.0.0.1.attacker.example']) {
    const response = await rawRequest(base, '/monitors', {
      method: 'POST', headers: { host, 'x-forwarded-host': 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Catalog', url: 'https://example.com' })
    });
    assert.equal(response.status, 403, host);
    assert.deepEqual(JSON.parse(response.body), { error: 'Only local requests are accepted' });
  }
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(store.list(), []);
});

test('cross-origin writes are rejected before parsing bodies or starting checks', async t => {
  const store = new Store();
  t.after(() => store.close());
  const runner = { run: t.mock.fn(() => assert.fail('Rejected request started a check')) };
  const base = await serve(t, createApp({ store, runner }));
  const created = await jsonRequest(base, '/monitors', 'POST', { name: 'Catalog', url: 'https://example.com' });
  const path = `/monitors/${created.body.id}`;
  for (const origin of ['null', base.replace('http:', 'https:'), 'http://attacker.example']) {
    for (const [method, route] of [['POST', '/monitors'], ['PATCH', path], ['DELETE', path], ['POST', `${path}/check`]]) {
      const response = await rawRequest(base, route, {
        method, headers: { origin, 'content-type': 'application/json' }, body: '{'
      });
      assert.equal(response.status, 403, `${origin} ${method} ${route}`);
      assert.deepEqual(JSON.parse(response.body), { error: 'Cross-origin requests are not accepted' });
      assert.deepEqual(store.get(created.body.id), created.body);
    }
  }
  assert.equal(runner.run.mock.callCount(), 0);
  assert.deepEqual(store.list(), [created.body]);
  assert.deepEqual(store.checks(created.body.id, 100), []);
});

test('compressed JSON is limited by its decoded size and valid requests still succeed', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const config = JSON.stringify({ name: 'Catalog é', url: 'https://example.com/health' });
  const exact = config + ' '.repeat(16384 - Buffer.byteLength(config));
  let saved = 0;
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    for (const [text, status] of [[exact, 201], [exact + ' ', 413]]) {
      const body = compress(Buffer.from(text));
      assert.ok(body.length < 1024);
      const response = await rawRequest(base, '/monitors', {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding }, body
      });
      assert.equal(response.status, status, `${encoding} ${Buffer.byteLength(text)}`);
      if (status === 201) {
        saved++;
        assert.equal(JSON.parse(response.body).name, 'Catalog é');
      } else assert.equal(typeof JSON.parse(response.body).error, 'string');
      assert.equal(store.list().length, saved);
    }
  }
  assert.equal((await jsonRequest(base, '/monitors', 'POST', { name: 'Next', url: 'https://example.com' })).status, 201);
  assert.equal(store.list().length, saved + 1);
});

test('synchronous store failures return a generic error and do not prevent later requests', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const listing = t.mock.method(store, 'list', () => { throw new Error('Private database path'); });
  assert.deepEqual(await jsonRequest(base, '/monitors'), {
    status: 500, body: { error: 'Internal server error' }
  });
  assert.deepEqual(await jsonRequest(base, '/health'), { status: 200, body: { status: 'ok' } });
  listing.mock.restore();
  assert.deepEqual(await jsonRequest(base, '/monitors'), { status: 200, body: [] });
});

test('accepts a 16 KiB JSON request and rejects one extra byte without writing data', async t => {
  const store = new Store();
  t.after(() => store.close());
  const base = await serve(t, createApp({ store }));
  const config = JSON.stringify({ name: 'Catalog é', url: 'https://example.com/health' });
  const exact = config + ' '.repeat(16384 - Buffer.byteLength(config));
  assert.equal(Buffer.byteLength(exact), 16384);
  for (const [body, status] of [[exact, 201], [exact + ' ', 413]]) {
    const response = await fetch(`${base}/monitors`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body
    });
    assert.equal(response.status, status);
    const result = await response.json();
    if (status === 201) assert.equal(result.name, 'Catalog é');
    else assert.equal(typeof result.error, 'string');
    assert.equal(store.list().length, 1);
  }
});
