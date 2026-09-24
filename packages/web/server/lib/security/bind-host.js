import net from 'node:net';
import { parseUiPasswordHash } from '../ui-auth/ui-password-hash.js';

const stripIpv6Brackets = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const normalizeIpv4MappedAddress = (host) => {
  const normalized = stripIpv6Brackets(host);
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? match[1] : normalized;
};

const isLoopbackIpv4 = (host) => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host) => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

export const isNetworkExposedBindHost = (host) => !isLoopbackBindHost(host);

export const isUnsafeUnauthenticatedLanAllowed = (env = process.env) =>
  env?.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true';

// UI auth counts as configured with either a non-blank plaintext password or a
// well-formed OPENCHAMBER_UI_PASSWORD_HASH.
export const isUiAuthConfigured = ({ password, passwordHash } = {}) =>
  (typeof password === 'string' && password.trim().length > 0)
  || parseUiPasswordHash(passwordHash) !== null;

export const getUnauthenticatedLanErrorMessage = (host) =>
  `OpenChamber refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password, OPENCHAMBER_UI_PASSWORD or OPENCHAMBER_UI_PASSWORD_HASH before exposing it over LAN, '
  + 'or set OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';
