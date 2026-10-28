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

test('JSON comparisons preserve primitive types and safely traverse nested values', async t => {
  const cases = [
    ['false', { ready: false }, 'ready', false, true],
    ['zero', { count: 0 }, 'count', 0, true],
    ['empty string', { message: '' }, 'message', '', true],
    ['null', { value: null }, 'value', null, true],
    ['array item', { items: [{ ready: true }] }, 'items.0.ready', true, true],
    ['numeric string', { count: '0' }, 'count', 0, false],
    ['boolean number', { ready: 0 }, 'ready', false, false],
    ['missing property', {}, 'value', null, false],
    ['missing array item', { items: [] }, 'items.0.ready', null, false],
    ['null parent', { data: null }, 'data.ready', null, false],
    ['primitive parent', { data: 'ready' }, 'data.length', 5, false],
    ['null root', null, 'ready', null, false],
    ['inherited property', {}, 'toString', null, false]
  ];
  for (const [name, body, path, equals, ok] of cases) {
    await t.test(name, async () => {
      const check = responseChecker({ statusCode: 200, body: JSON.stringify(body) });
      const result = await check({ ...monitor, expectedJson: { path, equals } });
      assert.equal(result.ok, ok);
      assert.equal(result.statusCode, 200);
      assert.equal(result.failureCode, ok ? null : 'json_mismatch');
    });
  }
});

test('configured non-200 responses succeed without requiring a JSON body', async () => {
  for (const [statusCode, body] of [[204, ''], [404, 'Not found'], [503, 'Maintenance']]) {
    const result = await responseChecker({ statusCode, body })({ ...monitor, expectedStatus: statusCode });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.failureCode, null);
    assert.equal(result.message, null);
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  }
});

test('response time thresholds are inclusive and failures follow status, latency, then JSON', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const check = createChecker({ lookup, request: async () => {
    now += 25;
    return { statusCode: 200, body: 'not JSON' };
  } });
  const expectedJson = { path: 'ready', equals: true };
  assert.equal((await check({ ...monitor, maxResponseMs: 25 })).ok, true);
  assert.equal((await check({ ...monitor, maxResponseMs: 24 })).failureCode, 'slow_response');
  assert.equal((await check({ ...monitor, maxResponseMs: 25, expectedJson })).failureCode, 'invalid_json');
  assert.equal((await check({ ...monitor, maxResponseMs: 24, expectedJson })).failureCode, 'slow_response');
  assert.equal((await check({ ...monitor, expectedStatus: 204, maxResponseMs: 24, expectedJson })).failureCode, 'status_mismatch');
});

test('unsafe saved targets are rejected before DNS or transport calls', async () => {
  const check = createChecker({
    lookup: async () => assert.fail('Unsafe target reached DNS'),
    request: async () => assert.fail('Unsafe target reached transport')
  });
  for (const url of ['http://127.0.0.1', 'http://service.internal', 'file:///tmp/health', 'not a URL']) {
    const result = await check({ ...monitor, url });
    assert.equal(result.failureCode, 'unsafe_target', url);
    assert.equal(result.statusCode, null);
  }
});

test('empty or invalid DNS answers never reach the transport', async () => {
  for (const addresses of [[], [{ address: 'not-an-ip', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: 'fc00::1', family: 6 }]]) {
    const check = createChecker({
      lookup: async () => addresses,
      request: async () => assert.fail('Unsafe DNS answer reached transport')
    });
    const result = await check(monitor);
    assert.equal(result.failureCode, 'unsafe_target');
    assert.equal(result.statusCode, null);
  }
});

test('public IPv4 and IPv6 literals bypass DNS and retain their address family', async () => {
  for (const [url, target] of [
    ['https://1.1.1.1/health', { address: '1.1.1.1', family: 4 }],
    ['https://[2606:4700:4700::1111]/health', { address: '2606:4700:4700::1111', family: 6 }]
  ]) {
    let requests = 0;
    const check = createChecker({
      lookup: async () => assert.fail('IP literal triggered DNS'),
      request: async (address, selected) => {
        requests++;
        assert.equal(address.href, url);
        assert.deepEqual(selected, target);
        return { statusCode: 200, body: '' };
      }
    });
    assert.equal((await check({ ...monitor, url })).ok, true);
    assert.equal(requests, 1);
  }
});

test('an already cancelled check never starts a request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stopped'));
  const check = createChecker({
    lookup,
    request: async () => assert.fail('Cancelled check started a request')
  });
  const result = await check(monitor, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'cancelled');
  assert.equal(result.statusCode, null);
});

test('cancellation interrupts DNS and response waits even when work finishes later', async t => {
  for (const stage of ['DNS', 'response']) {
    await t.test(stage, async () => {
      const entered = Promise.withResolvers();
      const pending = Promise.withResolvers();
      const controller = new AbortController();
      let requests = 0;
      const check = createChecker({
        lookup: stage === 'DNS' ? () => {
          entered.resolve();
          return pending.promise;
        } : lookup,
        request: () => {
          requests++;
          entered.resolve();
          return pending.promise;
        }
      });
      const running = check(monitor, controller.signal);
      await entered.promise;
      controller.abort(new Error('Stopped'));
      const result = await running;
      assert.equal(result.failureCode, 'cancelled');
      assert.equal(result.statusCode, null);
      pending.resolve(stage === 'DNS' ? await lookup() : { statusCode: 200, body: '' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests, stage === 'DNS' ? 0 : 1);
    });
  }
});

test('HTTP transport preserves the request target, headers and split UTF-8 characters', async t => {
  const requests = [];
  const body = Buffer.from('{"message":"ready 🌡️"}');
  const split = body.indexOf(Buffer.from('🌡')) + 2;
  const base = await serve(t, http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    res.write(body.subarray(0, split));
    setImmediate(() => res.end(body.subarray(split)));
  }));
  const url = new URL(`http://monitor.example.com:${new URL(base).port}/health?region=ca%20west`);
  const result = await requestTarget(url, { address: '127.0.0.1', family: 4 }, AbortSignal.timeout(2000));
  assert.deepEqual(result, { statusCode: 200, body: body.toString('utf8') });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, '/health?region=ca%20west');
  assert.equal(requests[0].headers.host, url.host);
  assert.equal(requests[0].headers['user-agent'], 'API-Health-Monitor/1.0');
  assert.equal(requests[0].headers['accept-encoding'], 'identity');
});

test('a disconnected response is a network failure instead of a partial success', async t => {
  const base = await serve(t, http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': '100' });
    res.write('{"ready":true}');
    setImmediate(() => res.destroy());
  }));
  const check = createChecker({
    lookup,
    request: (url, target, signal) => requestTarget(
      new URL(base), { address: '127.0.0.1', family: 4 }, signal
    )
  });
  const result = await check(monitor);
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'network_error');
  assert.equal(result.statusCode, null);
  assert.equal(result.message, 'Connection failed');
});
