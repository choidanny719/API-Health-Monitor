import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { validateMonitor } from '../src/validation.js';
import { jsonRequest } from './helpers.js';

async function serverFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'server-'));
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const portServer = net.createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const path = join(dir, 'test.db');

  async function start() {
    const child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(port), DB_PATH: path },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    children.push({ child, exited });
    let output = '';
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('listening')) resolve();
      });
    });
    await Promise.race([ready, exited.then(([code, signal]) => {
      throw new Error(`Server exited before startup: ${code ?? signal}: ${error}`);
    })]);
    return { child, exited };
  }

  async function stop(server, signal = 'SIGTERM') {
    server.child.kill(signal);
    assert.deepEqual(await server.exited, [0, null]);
  }

  return { base, path, start, stop };
}

test('server starts, persists a monitor across restart and exits on SIGTERM', { timeout: 10000 }, async t => {
  const fixture = await serverFixture(t);
  const first = await fixture.start();
  const created = await jsonRequest(fixture.base, '/monitors', 'POST', {
    name: 'Paused API', url: 'https://example.com/health', enabled: false
  });
  assert.equal(created.status, 201);
  await fixture.stop(first);
  const second = await fixture.start();
  assert.deepEqual((await jsonRequest(fixture.base, `/monitors/${created.body.id}`)).body, created.body);
  await fixture.stop(second);
});

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function expectStartupFailure(env, message) {
  await assert.rejects(promisify(execFile)(process.execPath, ['src/server.js'], {
    env: { ...process.env, ...env }, timeout: 3000
  }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.signal, null);
    assert.match(error.stderr, message);
    assert.doesNotMatch(error.stdout, /listening/);
    return true;
  });
}

test('server rejects invalid PORT settings before listening', async t => {
  const path = join(temporaryDirectory(t), 'test.db');
  for (const port of ['', '0', '-1', '65536', '3.5', 'abc', 'Infinity']) {
    await expectStartupFailure({ PORT: port, DB_PATH: path }, /PORT must be an integer between 1 and 65535/);
  }
});

test('server exits when its port is already in use', async t => {
  const path = join(temporaryDirectory(t), 'test.db');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await expectStartupFailure({ PORT: String(listener.address().port), DB_PATH: path }, /EADDRINUSE/);
});

test('server exits when the database directory cannot be created', async t => {
  const path = join(temporaryDirectory(t), 'file');
  writeFileSync(path, 'not a directory');
  await expectStartupFailure({ PORT: '3000', DB_PATH: join(path, 'test.db') }, /EEXIST|ENOTDIR/);
});

test('monitor revisions, checks and resolved incidents survive SIGINT and restart', { timeout: 10000 }, async t => {
  const fixture = await serverFixture(t);
  const store = new Store(fixture.path);
  let monitor;
  let checks;
  try {
    monitor = store.create(validateMonitor({ name: 'Paused API', url: 'https://example.com', enabled: false }), 0);
    for (let i = 1; i <= 3; i++) {
      store.record(monitor, {
        checkedAt: new Date(i * 1000).toISOString(), ok: false, statusCode: 503,
        durationMs: 5, failureCode: 'status_mismatch', message: 'Unavailable'
      }, i * 1000);
    }
    checks = store.checks(monitor.id, 100);
  } finally {
    store.close();
  }
  const path = `/monitors/${monitor.id}`;
  const first = await fixture.start();
  assert.equal((await jsonRequest(fixture.base, path)).body.status, 'down');
  assert.equal((await jsonRequest(fixture.base, `${path}/incidents`)).body[0].resolvedAt, null);
  const changed = await jsonRequest(fixture.base, path, 'PATCH', { name: 'Renamed API' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.revision, 2);
  assert.equal(changed.body.enabled, false);
  const incidents = (await jsonRequest(fixture.base, `${path}/incidents`)).body;
  assert.equal(incidents[0].resolution, 'configuration_changed');
  assert.ok(incidents[0].resolvedAt);
  await fixture.stop(first, 'SIGINT');
  const second = await fixture.start();
  assert.deepEqual(await jsonRequest(fixture.base, path), { status: 200, body: changed.body });
  assert.deepEqual(await jsonRequest(fixture.base, `${path}/checks`), { status: 200, body: checks });
  assert.deepEqual(await jsonRequest(fixture.base, `${path}/incidents`), { status: 200, body: incidents });
  await fixture.stop(second);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} closes an unfinished request without saving a partial monitor`, { timeout: 7000 }, async t => {
    const fixture = await serverFixture(t);
    const server = await fixture.start();
    const address = new URL(fixture.base);
    const client = net.createConnection({ host: address.hostname, port: Number(address.port) });
    t.after(() => client.destroy());
    await once(client, 'connect');
    const continued = new Promise((resolve, reject) => {
      let response = '';
      client.on('data', chunk => {
        response += chunk;
        if (response.includes('\r\n\r\n')) resolve(response);
      });
      client.once('error', reject);
    });
    const closed = new Promise(resolve => client.once('close', resolve));
    client.write(`POST /monitors HTTP/1.1\r\nHost: ${address.host}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{`);
    assert.match(await continued, /^HTTP\/1\.1 100 Continue\r\n/);
    await Promise.all([fixture.stop(server, signal), closed]);
    const reopened = new Store(fixture.path);
    try {
      assert.deepEqual(reopened.list(), []);
    } finally {
      reopened.close();
    }
    const restarted = await fixture.start();
    assert.deepEqual(await jsonRequest(fixture.base, '/health'), { status: 200, body: { status: 'ok' } });
    assert.equal((await jsonRequest(fixture.base, '/monitors', 'POST', {
      name: 'Complete monitor', url: 'https://example.com', enabled: false
    })).status, 201);
    await fixture.stop(restarted);
  });
}

test('server rejects a corrupt database before opening its port', async t => {
  const path = join(temporaryDirectory(t), 'corrupt.db');
  writeFileSync(path, 'This is not a SQLite database');
  await expectStartupFailure({ PORT: '3000', DB_PATH: path }, /file is not a database/);
});
