import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createChecker, requestTarget } from '../src/checker.js';
import { validateMonitor } from '../src/validation.js';
import { serve } from './helpers.js';

const execute = promisify(execFile);
let directory;
const fixture = name => join(directory, name);
const target = { address: '127.0.0.1', family: 4 };

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'monitor-tls-'));
  await execute('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '2', '-subj', '/CN=monitor.example.com',
    '-addext', 'subjectAltName=DNS:monitor.example.com',
    '-keyout', fixture('server-key.pem'), '-out', fixture('server-cert.pem')]);
  await execute('openssl', ['x509', '-in', fixture('server-cert.pem'), '-signkey', fixture('server-key.pem'),
    '-days', '-1', '-out', fixture('expired-cert.pem')]);
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function tlsServer(t, certificate = 'server-cert.pem') {
  const requests = [];
  const base = await serve(t, https.createServer({
    key: readFileSync(fixture('server-key.pem')),
    cert: readFileSync(fixture(certificate))
  }, (req, res) => {
    requests.push({ host: req.headers.host, servername: req.socket.servername, path: req.url });
    res.end('{"ready":true}');
  }));
  return { url: new URL(`https://monitor.example.com:${new URL(base).port}/health`), requests };
}

async function trustedRequest(url, certificate = 'server-cert.pem') {
  const script = `
    import { requestTarget } from ${JSON.stringify(new URL('../src/checker.js', import.meta.url).href)};
    try {
      const response = await requestTarget(new URL(process.argv[1]),
        { address: '127.0.0.1', family: 4 }, AbortSignal.timeout(2000));
      console.log(JSON.stringify(response));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code }));
    }
  `;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', script, url.href], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: fixture(certificate) },
    timeout: 5000
  });
  return JSON.parse(stdout);
}

test('HTTPS rejects an untrusted certificate and records a network failure', async t => {
  const { url, requests } = await tlsServer(t);
  await assert.rejects(requestTarget(url, target, AbortSignal.timeout(2000)), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT'
  });
  const check = createChecker({
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    request: (address, validated, signal) => requestTarget(address, target, signal)
  });
  const result = await check(validateMonitor({ name: 'TLS fixture', url: url.href }));
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'network_error');
  assert.equal(result.statusCode, null);
  assert.deepEqual(requests, []);
});

test('HTTPS preserves hostname verification and SNI when connecting to a pinned address', async t => {
  const { url, requests } = await tlsServer(t);
  assert.deepEqual(await trustedRequest(url), { statusCode: 200, body: '{"ready":true}' });
  assert.deepEqual(requests, [{ host: url.host, servername: 'monitor.example.com', path: '/health' }]);
  const mismatch = new URL(url);
  mismatch.hostname = 'other.example.com';
  assert.deepEqual(await trustedRequest(mismatch), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(requests.length, 1);
});

test('HTTPS rejects an expired certificate even when it is explicitly trusted', async t => {
  const { url, requests } = await tlsServer(t, 'expired-cert.pem');
  assert.deepEqual(await trustedRequest(url, 'expired-cert.pem'), { code: 'CERT_HAS_EXPIRED' });
  assert.deepEqual(requests, []);
});
