import { HttpError } from './errors.js';
import { parseTarget } from './url.js';

const defaults = {
  intervalSeconds: 60,
  timeoutMs: 5000,
  expectedStatus: 200,
  maxResponseMs: null,
  expectedJson: null,
  enabled: true
};
const fields = ['name', 'url', ...Object.keys(defaults)];

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
}

function validJsonPath(path) {
  return typeof path === 'string' && path.length <= 200 &&
    /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(path) &&
    !path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
}

function validJsonValue(value) {
  if (typeof value === 'string') return value.length <= 1000;
  if (typeof value === 'number') return Number.isFinite(value);
  return value === null || typeof value === 'boolean';
}

function validateExpectedJson(rule) {
  if (rule === null) return;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
    Object.keys(rule).length !== 2 || !Object.hasOwn(rule, 'equals') ||
    !validJsonPath(rule.path) || !validJsonValue(rule.equals)) {
    throw new HttpError(400, 'expectedJson must contain a dot-separated path and a primitive equals value');
  }
}

export function validateMonitor(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  if (Object.keys(body).length === 0 || Object.keys(body).some(key => !fields.includes(key))) {
    throw new HttpError(400, `Provide monitor fields: ${fields.join(', ')}`);
  }
  const config = { ...defaults, ...current, ...body };
  if (typeof config.name !== 'string' || !config.name.trim() || config.name.trim().length > 100) {
    throw new HttpError(400, 'name must contain 1 to 100 characters');
  }
  config.name = config.name.trim();
  config.url = parseTarget(config.url).href;
  integer(config.intervalSeconds, 'intervalSeconds', 10, 86400);
  integer(config.timeoutMs, 'timeoutMs', 100, 30000);
  if (config.timeoutMs > config.intervalSeconds * 1000) {
    throw new HttpError(400, 'timeoutMs must not exceed the check interval');
  }
  integer(config.expectedStatus, 'expectedStatus', 200, 599);
  if (config.expectedStatus >= 300 && config.expectedStatus < 400) {
    throw new HttpError(400, 'Redirect responses are not supported');
  }
  if (config.maxResponseMs !== null) integer(config.maxResponseMs, 'maxResponseMs', 1, config.timeoutMs);
  if (typeof config.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
  validateExpectedJson(config.expectedJson);
  return Object.fromEntries(fields.map(field => [field, config[field]]));
}

export function historyLimit(value) {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, 'limit must be an integer');
  const limit = Number(value);
  integer(limit, 'limit', 1, 100);
  return limit;
}
