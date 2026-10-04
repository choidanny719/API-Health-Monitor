import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { promisify } from 'node:util';
import { jsonRequest } from './helpers.js';

test('server starts, persists a monitor across restart and exits on SIGTERM', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'server-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const portServer = net.createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;

  async function start() {
    const child = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited before startup: ${code}`)));
      child.stdout.on('data', chunk => { if (chunk.toString().includes('listening')) resolve(); });
    });
    return child;
  }

  async function stop(child) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
  }

  const first = await start();
  const created = await jsonRequest(base, '/monitors', 'POST', {
    name: 'Paused API', url: 'https://example.com/health', enabled: false
  });
  assert.equal(created.status, 201);
  await stop(first);
  const second = await start();
  assert.deepEqual((await jsonRequest(base, `/monitors/${created.body.id}`)).body, created.body);
  await stop(second);
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
