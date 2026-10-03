import { isJsonValue, type HostResultPayload, type JsonValue } from './contract.ts';

export const GUEST_LOOPBACK_METHODS = ['GET', 'HEAD', 'POST'] as const;
export const GUEST_LOOPBACK_PORT_MIN = 1024;
export const GUEST_LOOPBACK_PORT_MAX = 65535;
export const GUEST_LOOPBACK_ENV = /^[A-Z][A-Z0-9_]*$/;
export const GUEST_LOOPBACK_ENV_MAX = 128;
export const GUEST_LOOPBACK_ROUTES_MAX = 32;
export const GUEST_LOOPBACK_PATH_MAX = 256;
export const GUEST_LOOPBACK_QUERY_BYTES = 2 * 1024;
export const GUEST_LOOPBACK_BODY_BYTES = 64 * 1024;
export const GUEST_LOOPBACK_RESPONSE_BYTES = 16 * 1024 * 1024;

export type LoopbackMethod = (typeof GUEST_LOOPBACK_METHODS)[number];
export type LoopbackRoute = {
  readonly path: string;
  readonly methods: readonly LoopbackMethod[];
};
export type LoopbackContribution = {
  readonly port: number;
  readonly env?: string;
  readonly routes: readonly LoopbackRoute[];
};
export type LoopbackUrlRequest = {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
};
export type LoopbackUrlResult = {
  readonly url: string;
  /** Scoped URL token expiry, in Unix milliseconds. Does not end a healthy stream. */
  readonly expiresAt: number;
};
export type LoopbackRequest = LoopbackUrlRequest & (
  | { readonly method: 'GET' | 'HEAD'; readonly body?: never }
  | { readonly method: 'POST'; readonly body?: JsonValue }
);
export type LoopbackRequestResult = {
  readonly status: number;
  readonly body: string;
};

const CONTROL = /\p{Cc}/u;
const methods: ReadonlySet<string> = new Set(GUEST_LOOPBACK_METHODS);

// Never use URL's dot-segment normalization before admission. Decode each
// segment once; a remaining '%' could acquire meaning in a second decoder.
const canonicalPath = (value: string, wildcard: boolean): string | null => {
  if (!value.startsWith('/') || value.length > GUEST_LOOPBACK_PATH_MAX || CONTROL.test(value)
    || /[\\?#]/u.test(value)) return null;
  if (value === '/') return value;
  const encoded: string[] = [];
  try {
    for (const segment of value.slice(1).split('/')) {
      if (wildcard && segment === '*') {
        encoded.push('*');
        continue;
      }
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === '.' || decoded === '..' || CONTROL.test(decoded)
        || /[/\\%?#*]/u.test(decoded)) return null;
      encoded.push(encodeURIComponent(decoded).replace(/[!'()]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`));
    }
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
  const path = `/${encoded.join('/')}`;
  return path.length <= GUEST_LOOPBACK_PATH_MAX ? path : null;
};

/** Canonical request pathname, or null. Match and forward this same value. */
export const canonicalizeLoopbackPath = (path: string): string | null => canonicalPath(path, false);

/** Manifest pathname; only a literal whole segment '*' has wildcard meaning. */
export const canonicalizeLoopbackRoutePath = (path: string): string | null => canonicalPath(path, true);

/** Returns the admitted canonical pathname, not a boolean or a target URL. */
export const matchLoopbackRoute = (
  routes: readonly LoopbackRoute[], path: string, method: LoopbackMethod,
): string | null => {
  const canonical = canonicalizeLoopbackPath(path);
  if (canonical === null) return null;
  const segments = canonical.split('/');
  return routes.some((route) => {
    if (!route.methods.includes(method)) return false;
    const pattern = route.path.split('/');
    return pattern.length === segments.length
      && pattern.every((part, index) => part === segments[index] || (part === '*' && Boolean(segments[index])));
  }) ? canonical : null;
};

/** Typed manifest admission, also used by capability derivation without Zod. */
export const isLoopbackContribution = (value: LoopbackContribution): boolean => (
  Number.isInteger(value.port) && value.port >= GUEST_LOOPBACK_PORT_MIN && value.port <= GUEST_LOOPBACK_PORT_MAX
  && (value.env === undefined || (value.env.length <= GUEST_LOOPBACK_ENV_MAX && GUEST_LOOPBACK_ENV.test(value.env)))
  && value.routes.length > 0 && value.routes.length <= GUEST_LOOPBACK_ROUTES_MAX
  && new Set(value.routes.map((route) => canonicalizeLoopbackRoutePath(route.path))).size === value.routes.length
  && value.routes.every((route) => canonicalizeLoopbackRoutePath(route.path) !== null
    && route.methods.length > 0 && route.methods.length <= GUEST_LOOPBACK_METHODS.length
    && new Set(route.methods).size === route.methods.length && route.methods.every((method) => methods.has(method)))
);

/** Query bytes are measured after URLSearchParams serialization, without '?'. */
export const isLoopbackQuery = (query: LoopbackUrlRequest['query']): boolean => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key.startsWith('oc_') || String(value) !== value) return false;
    params.append(key, value);
  }
  return params.toString().length <= GUEST_LOOPBACK_QUERY_BYTES;
};

export const isLoopbackBody = (body: JsonValue): boolean => {
  try {
    return isJsonValue(body) && new TextEncoder().encode(JSON.stringify(body)).byteLength <= GUEST_LOOPBACK_BODY_BYTES;
  } catch (error) {
    // JS callers can pass cyclic objects despite the JsonValue contract.
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
};

export const isLoopbackUrlResult = (value: HostResultPayload | undefined): value is LoopbackUrlResult => {
  if (!value || !('url' in value) || !('expiresAt' in value)
    || String(value.url) !== value.url || value.url.length > 8192
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return false;
  try {
    const url = new URL(value.url);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

export const isLoopbackRequestResult = (value: HostResultPayload | undefined): value is LoopbackRequestResult => (
  Boolean(value && 'status' in value && 'body' in value && Number.isInteger(value.status)
    && value.status >= 100 && value.status <= 599 && String(value.body) === value.body
    && new TextEncoder().encode(value.body).byteLength <= GUEST_LOOPBACK_RESPONSE_BYTES)
);
