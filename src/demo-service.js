import { createChecker } from './checker.js';
import { HttpError } from './errors.js';
import { Runner } from './runner.js';
import { Store } from './store.js';
import { validateMonitor } from './validation.js';

const scenarios = [
  {
    id: 'recovery',
    title: 'Outage and recovery',
    description: 'See an incident open after three failed checks, then resolve when the API recovers.',
    steps: [
      { label: 'API returns HTTP 503', response: { statusCode: 503, body: '{"error":"temporarily unavailable"}' } },
      { label: 'API returns HTTP 200 with the wrong value', response: { statusCode: 200, body: '{"data":{"ready":false}}' } },
      { label: 'API times out', delayMs: 1200 },
      { label: 'API recovers', response: { statusCode: 200, body: '{"data":{"ready":true}}' } }
    ]
  },
  {
    id: 'wrong-json',
    title: 'HTTP 200, wrong JSON',
    description: 'The server answers, but its readiness field says the service is not ready.',
    steps: [
      { label: 'Check the readiness field', response: { statusCode: 200, body: '{"data":{"ready":false}}' } }
    ]
  },
  {
    id: 'slow-response',
    title: 'Slow response',
    description: 'The API returns the right value after the configured response limit.',
    steps: [
      { label: 'Check the response time', delayMs: 250, response: { statusCode: 200, body: '{"data":{"ready":true}}' } }
    ]
  },
  {
    id: 'healthy',
    title: 'Healthy API',
    description: 'A normal check passes both the status and JSON rules.',
    steps: [
      { label: 'Check the API', response: { statusCode: 200, body: '{"data":{"ready":true}}' } }
    ]
  }
];

function waitForResponse(step, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(step.response);
    }, step.delayMs);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function publicMonitor(monitor) {
  return {
    name: monitor.name,
    status: monitor.status,
    consecutiveFailures: monitor.consecutiveFailures,
    lastCheckedAt: monitor.lastCheckedAt
  };
}

export function createDemoService({ maxConcurrentRuns = 4 } = {}) {
  let activeRuns = 0;

  async function run(scenarioId) {
    const scenario = scenarios.find(item => item.id === scenarioId);
    if (!scenario) throw new HttpError(400, 'Choose a listed demo scenario');
    if (activeRuns >= maxConcurrentRuns) throw new HttpError(429, 'The demo is busy; try again in a moment');
    activeRuns++;
    const store = new Store();
    let step;
    const config = validateMonitor({
      name: 'Checkout API',
      url: 'https://checkout.example.com/health',
      intervalSeconds: 10,
      timeoutMs: 450,
      maxResponseMs: 120,
      expectedJson: { path: 'data.ready', equals: true }
    });
    const monitor = store.create(config);
    const checker = createChecker({
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
      request: async (url, target, signal) => step.delayMs
        ? waitForResponse(step, signal)
        : step.response
    });
    const runner = new Runner(store, checker, { concurrency: 1 });

    try {
      const checks = [];
      for (step of scenario.steps) {
        const result = await runner.run(monitor.id);
        checks.push({
          label: step.label,
          ...result,
          status: store.get(monitor.id).status,
          consecutiveFailures: store.get(monitor.id).consecutiveFailures
        });
      }
      return {
        scenario: { id: scenario.id, title: scenario.title },
        monitor: publicMonitor(store.get(monitor.id)),
        checks,
        incidents: store.incidents(monitor.id, 100)
      };
    } finally {
      await runner.stop();
      store.close();
      activeRuns--;
    }
  }

  return {
    scenarios: () => scenarios.map(({ id, title, description }) => ({ id, title, description })),
    run
  };
}
