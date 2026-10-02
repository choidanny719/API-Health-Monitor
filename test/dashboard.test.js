import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { createDemoService } from '../src/demo-service.js';
import { createApp } from '../src/app.js';
import { serve } from './helpers.js';

test('serves a self-contained dashboard and browser assets with a restrictive content policy', async t => {
  const store = new Store();
  const runner = new Runner(store, async () => ({}));
  const base = await serve(t, createApp({ store, runner, demo: createDemoService(), publicDemo: true }));
  t.after(() => store.close());

  const page = await fetch(base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(html, /Know when an API is/);
  assert.match(html, /Run scenario/);
  assert.match(html, /\/styles\.css/);
  assert.match(html, /\/app\.js/);

  const styles = await fetch(`${base}/styles.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /text\/css/);
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.match(await script.text(), /\/api\/demo\/run/);
});
