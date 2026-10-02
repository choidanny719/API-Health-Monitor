import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { HttpError } from './errors.js';

export function isPublicAddress(address) {
  if (!isIP(address)) return false;
  return ipaddr.process(address).range() === 'unicast';
}

export function parseTarget(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new HttpError(400, 'url must be an HTTP or HTTPS URL');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'url must be an HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new HttpError(400, 'url must use HTTP or HTTPS without credentials or a fragment');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname.includes('.') && !isIP(hostname)) {
    throw new HttpError(400, 'url must use a public hostname or IP address');
  }
  if (['localhost', 'local', 'internal', 'test', 'invalid'].some(suffix =>
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new HttpError(400, 'Private and reserved network targets are blocked');
  }
  return url;
}
