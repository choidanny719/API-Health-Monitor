import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
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
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'test.db'), HOST: '127.0.0.1', PUBLIC_DEMO: 'true' },
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
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Interactive demo/);
  const scenarioResponse = await fetch(`${base}/api/demo/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: 'wrong-json' })
  });
  assert.equal(scenarioResponse.status, 200);
  assert.equal((await scenarioResponse.json()).checks[0].failureCode, 'json_mismatch');
  const created = await jsonRequest(base, '/monitors', 'POST', {
    name: 'Paused API', url: 'https://example.com/health', enabled: false
  });
  assert.equal(created.status, 201);
  await stop(first);
  const second = await start();
  assert.deepEqual((await jsonRequest(base, `/monitors/${created.body.id}`)).body, created.body);
  await stop(second);
});
