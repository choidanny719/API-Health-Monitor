import express from 'express';
import { historyLimit, validateMonitor } from './validation.js';

export function createApp({ store, runner } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/monitors', (req, res) => {
    res.json(store.list());
  });

  app.post('/monitors', (req, res) => {
    const monitor = store.create(validateMonitor(req.body));
    res.status(201).location(`/monitors/${monitor.id}`).json(monitor);
  });

  app.get('/monitors/:id', (req, res) => {
    res.json(store.get(req.params.id));
  });

  app.patch('/monitors/:id', (req, res) => {
    const monitor = store.get(req.params.id);
    res.json(store.update(monitor.id, validateMonitor(req.body, monitor)));
  });

  app.delete('/monitors/:id', (req, res) => {
    store.delete(req.params.id);
    res.status(204).end();
  });

  app.post('/monitors/:id/check', async (req, res) => {
    res.status(201).json(await runner.run(req.params.id));
  });

  app.get('/monitors/:id/checks', (req, res) => {
    res.json(store.checks(req.params.id, historyLimit(req.query.limit)));
  });

  app.get('/monitors/:id/incidents', (req, res) => {
    res.json(store.incidents(req.params.id, historyLimit(req.query.limit)));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? 500;
    res.status(status).json({ error: status < 500 ? error.message : 'Internal server error' });
  });

  return app;
}
