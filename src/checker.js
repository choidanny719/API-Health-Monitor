import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, parseTarget } from './url.js';

export class CheckFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function resolveTarget(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new CheckFailure('dns_error', 'DNS lookup failed');
  }
  if (!addresses.length || addresses.some(target => !isPublicAddress(target.address))) {
    throw new CheckFailure('unsafe_target', 'DNS resolved to a private or reserved address');
  }
  return addresses[0];
}

export function requestTarget(url, target, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      agent: false,
      signal,
      family: target.family,
      lookup: (hostname, options, callback) => {
        if (options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
      headers: { 'user-agent': 'API-Health-Monitor/1.0', accept: 'application/json, */*', 'accept-encoding': 'identity' }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        request.destroy();
        reject(new CheckFailure('redirect', 'Redirects are not followed'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) {
          request.destroy();
          reject(new CheckFailure('response_too_large', 'Response exceeded 64 KiB'));
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function evaluate(response, monitor, durationMs) {
  if (response.statusCode !== monitor.expectedStatus) {
    throw new CheckFailure('status_mismatch', `Expected HTTP ${monitor.expectedStatus}, received ${response.statusCode}`);
  }
  if (monitor.maxResponseMs !== null && durationMs > monitor.maxResponseMs) {
    throw new CheckFailure('slow_response', `Response exceeded ${monitor.maxResponseMs} ms`);
  }
  if (monitor.expectedJson !== null) {
    let value;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new CheckFailure('invalid_json', 'Response is not valid JSON');
    }
    for (const key of monitor.expectedJson.path.split('.')) {
      value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
    }
    if (value !== monitor.expectedJson.equals) {
      throw new CheckFailure('json_mismatch', `Unexpected value at ${monitor.expectedJson.path}`);
    }
  }
}

export function createChecker({ lookup = dnsLookup, request = requestTarget } = {}) {
  return async function check(monitor, externalSignal) {
    const started = performance.now();
    const checkedAt = new Date().toISOString();
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), monitor.timeoutMs);
    let statusCode = null;
    const duration = () => Math.round((performance.now() - started) * 100) / 100;
    try {
      let url;
      try {
        url = parseTarget(monitor.url);
      } catch (error) {
        throw new CheckFailure('unsafe_target', error.message);
      }
      const target = await resolveTarget(url, lookup, signal);
      signal.throwIfAborted();
      const response = await abortable(request(url, target, signal), signal);
      statusCode = response.statusCode;
      const durationMs = duration();
      evaluate(response, monitor, durationMs);
      return { checkedAt, ok: true, statusCode, durationMs, failureCode: null, message: null };
    } catch (error) {
      const failureCode = externalSignal?.aborted ? 'cancelled' : signal.aborted ? 'timeout' : error.code;
      const known = error instanceof CheckFailure;
      return {
        checkedAt,
        ok: false,
        statusCode,
        durationMs: duration(),
        failureCode: ['timeout', 'cancelled'].includes(failureCode) || known ? failureCode : 'network_error',
        message: signal.aborted ? 'Check stopped before completion' : known ? error.message : 'Connection failed'
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
