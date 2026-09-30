import { createApp } from './app.js';
import { Store } from './store.js';
import { createChecker } from './checker.js';
import { Runner } from './runner.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const store = new Store(process.env.DB_PATH ?? 'data/monitor.db');
const runner = new Runner(store, createChecker());
const server = createApp({ store, runner }).listen(port, '127.0.0.1', () => {
  runner.start();
  console.log(`API Health Monitor listening at http://localhost:${port}`);
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => server.closeAllConnections(), 2000);
  await Promise.all([
    runner.stop(),
    new Promise(resolve => server.close(resolve))
  ]);
  clearTimeout(deadline);
  store.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, shutdown);
}
