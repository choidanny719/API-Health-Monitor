import express from 'express';
import { fileURLToPath } from 'node:url';
import { historyLimit, validateMonitor } from './validation.js';
import { HttpError } from './errors.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const localHosts = ['localhost', '127.0.0.1', '[::1]'];
const demoFiles = new Set(['/', '/index.html', '/styles.css', '/app.js', '/favicon.svg']);

export function createApp({ store, runner, demo, publicDemo = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use((req, res, next) => {
    const isDemoFile = publicDemo && ['GET', 'HEAD'].includes(req.method) && demoFiles.has(req.path);
    const isDemoApi = publicDemo && ['/api/demo/scenarios', '/api/demo/run'].includes(req.path);
    if (isDemoFile) return next();
    if (isDemoApi) {
      const origin = req.get('origin');
      if (origin) {
        try {
          if (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).host !== req.get('host')) {
            return res.status(403).json({ error: 'Cross-origin requests are not accepted' });
          }
        } catch {
          return res.status(403).json({ error: 'Cross-origin requests are not accepted' });
        }
      }
      res.set('Cache-Control', 'no-store');
      return next();
    }
    if (!localHosts.includes(req.hostname)) {
      return res.status(403).json({ error: 'Only local requests are accepted' });
    }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return res.status(403).json({ error: 'Cross-origin requests are not accepted' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  if (publicDemo) app.use(express.static(publicDirectory, { index: 'index.html', maxAge: '1h' }));

  if (publicDemo && demo) {
    app.get('/api/demo/scenarios', (req, res) => {
      res.json({ monitor: 'Checkout API', scenarios: demo.scenarios() });
    });

    app.post('/api/demo/run', async (req, res) => {
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.scenario !== 'string') {
        throw new HttpError(400, 'Body must contain one scenario ID');
      }
      res.json(await demo.run(req.body.scenario));
    });
  }

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
