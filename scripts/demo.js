import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createChecker, requestTarget } from '../src/checker.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';

let mode = 'healthy';
const fixture = http.createServer((req, res) => {
  if (mode === 'timeout') {
    res.writeHead(200);
    res.flushHeaders();
    return;
  }
  res.writeHead(mode === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ready: mode === 'healthy' }));
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');

const store = new Store();
const checker = createChecker({
  lookup: async () => [{ address: '93.184.215.14', family: 4 }],
  request: (url, target, signal) => requestTarget(
    new URL(`http://127.0.0.1:${fixture.address().port}/health`),
    { address: '127.0.0.1', family: 4 },
    signal
  )
});
const runner = new Runner(store, checker);
const api = createApp({ store, runner }).listen(0, '127.0.0.1');
await once(api, 'listening');
const base = `http://127.0.0.1:${api.address().port}`;

async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  assert.ok(response.ok, `HTTP ${response.status} from ${path}`);
  return response.json();
}

try {
  const monitor = await request('/monitors', 'POST', {
    name: 'Demo API', url: 'https://catalog.example/health', timeoutMs: 150,
    expectedJson: { path: 'ready', equals: true }
  });
  const path = `/monitors/${monitor.id}`;
  for (const scenario of ['healthy', 'wrong_json', 'unavailable', 'timeout', 'healthy']) {
    mode = scenario;
    const result = await request(`${path}/check`, 'POST');
    const current = await request(path);
    console.log(`${scenario.padEnd(12)} ${String(result.statusCode ?? '-').padEnd(4)} ${(result.failureCode ?? 'passed').padEnd(16)} state=${current.status} failures=${current.consecutiveFailures}`);
    if (scenario === 'timeout') {
      assert.equal(current.status, 'down');
      const incidents = await request(`${path}/incidents`);
      assert.equal(incidents.length, 1);
      assert.equal(incidents[0].resolvedAt, null);
    }
  }
  const [incident] = await request(`${path}/incidents`);
  assert.equal(incident.resolution, 'recovered');
  assert.equal((await request(`${path}/checks`)).length, 5);
  console.log('Incident opened after three failures and resolved on recovery. All requests stayed local.');
} finally {
  await runner.stop();
  await Promise.all([api, fixture].map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  store.close();
}
