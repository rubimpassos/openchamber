import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

const REQUEST_TIMEOUT_MS = 8_000;

const buildStatsUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/api/system/stats`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

/**
 * Reads machine stats from a saved host other than the one the window is
 * connected to, for the instance list. The token never leaves the main
 * process; the renderer only gets the stats payload, which it validates.
 *
 * Resolves `{ status: 'ok', sample }`, `{ status: 'auth' }` when the saved
 * token is refused, `{ status: 'unsupported' }` when the host predates the
 * route, or `{ status: 'failed' }` (unreachable, timeout, non-HTTP address
 * such as a relay-only host).
 */
export const fetchRemoteHostStats = async ({
  url,
  clientToken = '',
  requestHeaders = {},
  chromiumFetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) => {
  const statsUrl = buildStatsUrl(url);
  if (!statsUrl) return { status: 'failed' };

  const headers = { ...sanitizeRuntimeRequestHeaders(requestHeaders), Accept: 'application/json' };
  const token = String(clientToken || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await chromiumFetch(statsUrl, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
    if (response.status === 401 || response.status === 403) return { status: 'auth' };
    if (response.status === 404) return { status: 'unsupported' };
    if (!response.ok) return { status: 'failed' };
    const sample = await response.json().catch(() => null);
    // Older servers forward unknown /api routes to OpenCode, which answers
    // with something else; the renderer's schema decides what is a sample.
    return sample === null ? { status: 'unsupported' } : { status: 'ok', sample };
  } catch {
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
};
