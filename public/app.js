const form = document.querySelector('#scenario-select');
const button = document.querySelector('#run-button');
const description = document.querySelector('#scenario-description');
const scenarioDetails = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setRunState(text, state) {
  const label = document.querySelector('#run-state');
  label.className = `run-state ${state}`;
  label.replaceChildren(element('span', 'state-dot'), document.createTextNode(text));
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function resultLabel(check) {
  if (check.failureCode === 'timeout') return { text: 'Timed out', style: 'failed' };
  if (check.failureCode === 'slow_response') return { text: 'Too slow', style: 'slow' };
  if (check.failureCode === 'status_mismatch') return { text: `HTTP ${check.statusCode}`, style: 'failed' };
  if (check.failureCode === 'json_mismatch') return { text: 'Wrong JSON', style: 'failed' };
  if (check.failureCode) return { text: 'Check failed', style: 'failed' };
  return { text: 'Passed', style: '' };
}

function renderChecks(checks) {
  const list = document.querySelector('#activity-list');
  list.replaceChildren();
  for (const [index, check] of checks.entries()) {
    const label = resultLabel(check);
    const row = element('div', 'activity-row');
    const name = element('div', 'check-name');
    name.append(element('span', 'check-index', String(index + 1).padStart(2, '0')));
    name.append(element('span', '', check.label));
    const result = element('span', `check-result ${label.style}`, label.text);
    const duration = element('span', 'check-time', check.durationMs === null ? '—' : `${Math.round(check.durationMs)} ms`);
    row.append(name, result, duration);
    list.append(row);
  }
}

function render(data) {
  const monitor = data.monitor;
  const status = document.querySelector('#service-status');
  const isUp = monitor.status === 'up';
  const isDown = monitor.status === 'down';
  const hasRecovered = data.incidents.some(incident => incident.resolvedAt);
  status.className = `status-value ${isUp ? 'up' : isDown ? 'down' : 'pending'}`;
  status.textContent = isUp ? 'Operational' : isDown ? 'Incident open' : 'Degraded';
  document.querySelector('#service-subtitle').textContent = isUp
    ? `${hasRecovered ? 'Recovered' : 'Healthy'} · last checked ${formatTime(monitor.lastCheckedAt)}`
    : isDown ? 'Three checks failed in a row' : 'A check did not meet the health rule';
  document.querySelector('#check-count').textContent = data.checks.length;
  document.querySelector('#failure-count').textContent = monitor.consecutiveFailures;
  document.querySelector('#failure-caption').textContent = monitor.status === 'down' ? 'Incident opened' : 'Incident opens at 3';
  document.querySelector('#activity-footer').textContent = `${data.checks.length} ${data.checks.length === 1 ? 'check' : 'checks'} recorded · ${data.checks.filter(check => check.ok).length} passed · ${data.checks.filter(check => !check.ok).length} failed`;
  setRunState('Recording complete', 'finished');
  renderChecks(data.checks);
  const panel = document.querySelector('#incident-panel');
  const incident = data.incidents[0];
  panel.hidden = !incident;
  if (incident) {
    const resolved = Boolean(incident.resolvedAt);
    document.querySelector('#incident-title').textContent = resolved ? 'Incident resolved' : 'Incident opened';
    document.querySelector('#incident-detail').textContent = resolved
      ? `Opened ${formatTime(incident.openedAt)} · resolved ${formatTime(incident.resolvedAt)}`
      : `Opened ${formatTime(incident.openedAt)} after 3 consecutive failures`;
    const badge = document.querySelector('#incident-status');
    badge.textContent = resolved ? 'Resolved' : 'Open';
    badge.className = `incident-status ${resolved ? 'resolved' : ''}`;
  }
}

form.addEventListener('change', () => {
  description.textContent = scenarioDetails.get(form.value)?.description ?? '';
});

button.addEventListener('click', async () => {
  button.disabled = true;
  button.querySelector('#run-icon').textContent = '…';
  button.querySelector('#run-label').textContent = 'Running scenario';
  setRunState('Checks in progress', 'running');
  document.querySelector('#incident-panel').hidden = true;
  try {
    const response = await fetch('/api/demo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: form.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? 'The demo could not run');
    render(payload);
  } catch (error) {
    setRunState('Could not run', '');
    const list = document.querySelector('#activity-list');
    const message = element('p', 'error-message', error.message);
    list.replaceChildren(message);
    document.querySelector('#activity-footer').textContent = 'Try again in a moment.';
  } finally {
    button.disabled = false;
    button.querySelector('#run-icon').textContent = '▶';
    button.querySelector('#run-label').textContent = 'Run again';
  }
});

try {
  const response = await fetch('/api/demo/scenarios');
  if (!response.ok) throw new Error('Demo scenarios are unavailable');
  const payload = await response.json();
  form.replaceChildren();
  for (const scenario of payload.scenarios) {
    scenarioDetails.set(scenario.id, scenario);
    form.append(new Option(scenario.title, scenario.id));
  }
  form.disabled = false;
  description.textContent = scenarioDetails.get(form.value)?.description ?? '';
  button.disabled = false;
} catch (error) {
  form.replaceChildren(new Option('Scenarios unavailable', ''));
  description.textContent = error.message;
  setRunState('Demo unavailable', '');
}
