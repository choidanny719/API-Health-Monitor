import { createApp } from './app.js';
import { Store } from './store.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const store = new Store(process.env.DB_PATH ?? 'data/monitor.db');
const server = createApp({ store }).listen(port, '127.0.0.1', () => {
  console.log(`API Health Monitor listening at http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => store.close()));
}
