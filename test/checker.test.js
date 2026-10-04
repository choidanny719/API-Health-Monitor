import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createChecker, requestTarget } from '../src/checker.js';
import { validateMonitor } from '../src/validation.js';
import { serve } from './helpers.js';

const monitor = validateMonitor({ name: 'Catalog', url: 'https://example.com/health' });
const lookup = async () => [{ address: '93.184.215.14', family: 4 }];
const responseChecker = response => createChecker({ lookup, request: async () => response });

test('evaluates status codes and nested JSON values', async () => {
  const check = responseChecker({ statusCode: 200, body: '{"data":{"ready":true}}' });
  const config = { ...monitor, expectedJson: { path: 'data.ready', equals: true } };
  assert.equal((await check(config)).ok, true);
  assert.equal((await check({ ...config, expectedStatus: 204 })).failureCode, 'status_mismatch');
  assert.equal((await check({ ...config, expectedJson: { path: 'data.ready', equals: 'true' } })).failureCode, 'json_mismatch');
  assert.equal((await check({ ...config, expectedJson: { path: 'missing', equals: null } })).failureCode, 'json_mismatch');
  assert.equal((await responseChecker({ statusCode: 200, body: 'oops' })(config)).failureCode, 'invalid_json');
});

test('blocks all requests when DNS includes any private address', async () => {
  let calls = 0;
  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:192.168.1.1', '169.254.169.254']) {
    const check = createChecker({
      lookup: async () => [...await lookup(), { address, family: address.includes(':') ? 6 : 4 }],
      request: async () => { calls++; }
    });
    assert.equal((await check(monitor)).failureCode, 'unsafe_target');
  }
  assert.equal(calls, 0);
});

test('passes the validated address to the transport without another DNS lookup', async () => {
  let lookups = 0;
  const check = createChecker({
    lookup: async () => { lookups++; return lookup(); },
    request: async (url, target) => {
      assert.equal(url.hostname, 'example.com');
      assert.deepEqual(target, { address: '93.184.215.14', family: 4 });
      return { statusCode: 200, body: '' };
    }
  });
  assert.equal((await check(monitor)).ok, true);
  assert.equal(lookups, 1);
});

test('DNS errors and slow or failed connections have distinct outcomes', async () => {
  const dns = createChecker({ lookup: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal((await dns(monitor)).failureCode, 'dns_error');
  const network = createChecker({ lookup, request: async () => { throw new Error('ECONNRESET'); } });
  assert.equal((await network(monitor)).failureCode, 'network_error');
  const slow = createChecker({ lookup, request: async () => {
    await delay(30);
    return { statusCode: 200, body: '' };
  } });
  assert.equal((await slow({ ...monitor, maxResponseMs: 1 })).failureCode, 'slow_response');
});

test('total timeout covers DNS resolution as well as the response', async () => {
  const hanging = () => new Promise(() => {});
  for (const options of [{ lookup: hanging }, { lookup, request: hanging }]) {
    const result = await createChecker(options)({ ...monitor, timeoutMs: 100 });
    assert.equal(result.failureCode, 'timeout');
    assert.ok(result.durationMs < 1000);
  }
});

test('HTTP transport pins DNS, refuses redirects, caps bodies and aborts slow responses', async t => {
  let redirectedRequests = 0;
  const base = await serve(t, http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/destination' }).end();
    } else if (req.url === '/destination') {
      redirectedRequests++;
      res.end('unexpected');
    } else if (req.url === '/large') {
      res.end('x'.repeat(65537));
    } else if (req.url === '/slow') {
      res.writeHead(200);
      res.flushHeaders();
    } else res.end('{"ready":true}');
  }));
  const port = new URL(base).port;
  const url = path => new URL(`http://does-not-resolve.invalid:${port}${path}`);
  const target = { address: '127.0.0.1', family: 4 };
  const signal = AbortSignal.timeout(2000);
  assert.equal((await requestTarget(url('/'), target, signal)).body, '{"ready":true}');
  await assert.rejects(requestTarget(url('/redirect'), target, signal), { code: 'redirect' });
  await assert.rejects(requestTarget(url('/large'), target, signal), { code: 'response_too_large' });
  await assert.rejects(requestTarget(url('/slow'), target, AbortSignal.timeout(100)), { name: 'AbortError' });
  assert.equal(redirectedRequests, 0);
});

test('response limits count bytes at 64 KiB for fixed and chunked bodies', async t => {
  const exact = 'é'.repeat(32768);
  assert.equal(Buffer.byteLength(exact), 65536);
  const base = await serve(t, http.createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture');
    const body = Buffer.from(exact + (path.searchParams.has('over') ? 'a' : ''));
    if (path.searchParams.has('chunked')) {
      res.write(body.subarray(0, 32000));
      res.end(body.subarray(32000));
    } else {
      res.setHeader('content-length', body.length);
      res.end(body);
    }
  }));
  const target = { address: '127.0.0.1', family: 4 };
  for (const transfer of ['', 'chunked=1&']) {
    const accepted = await requestTarget(new URL(`${base}/?${transfer}`), target, AbortSignal.timeout(2000));
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body, exact);
    await assert.rejects(
      requestTarget(new URL(`${base}/?${transfer}over=1`), target, AbortSignal.timeout(2000)),
      { code: 'response_too_large' }
    );
  }
});
