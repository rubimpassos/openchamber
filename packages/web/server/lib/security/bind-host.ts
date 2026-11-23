import net from 'node:net';
import { parseUiPasswordHash } from '../ui-auth/ui-password-hash.js';
import { isString } from '../shared/guards.js';

const stripIpv6Brackets = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const normalizeIpv4MappedAddress = (host: string) => {
  const normalized = stripIpv6Brackets(host);
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match?.[1] ?? normalized;
};

const isLoopbackIpv4 = (host: string) => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host: string) => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

export const isNetworkExposedBindHost = (host: string) => !isLoopbackBindHost(host);

export const isUnsafeUnauthenticatedLanAllowed = (env: NodeJS.ProcessEnv | null = process.env) =>
  env?.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true';

export const isUiAuthConfigured = ({ password, passwordHash }: {
  readonly password?: unknown;
  readonly passwordHash?: unknown;
} = {}) =>
  (isString(password) && password.trim().length > 0)
  || (isString(passwordHash) && parseUiPasswordHash(passwordHash) !== null);

export const getUnauthenticatedLanErrorMessage = (host: string) =>
  `OpenChamber refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password, OPENCHAMBER_UI_PASSWORD or OPENCHAMBER_UI_PASSWORD_HASH before exposing it over LAN, '
  + 'or set OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';

export const readAdvertisedLanUrl = (env: NodeJS.ProcessEnv | null = process.env, logger: Pick<Console, 'warn'> = console) => {
  const raw = String(env?.OPENCHAMBER_LAN_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
    logger.warn(`[config] Ignoring OPENCHAMBER_LAN_URL=${JSON.stringify(raw)}: expected an origin such as http://192.168.1.20:3000`);
    return null;
  }
  return url.origin;
};
