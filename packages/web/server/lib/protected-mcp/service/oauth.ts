import { isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import { destinationFingerprint, LOOPBACK_HOSTS } from './definitions.js';
import { createOAuthAuthorization } from './oauth-authorization.js';
import type { HttpConnection, OAuthAnswer, OAuthClient, OAuthCredentials, OAuthLog, OAuthServer, OAuthStore, OAuthTokens } from './oauth-authorization.js';
import type { ConnectionId } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { isStoredOAuthTokens, oauthObject } from './oauth-storage.js';
import type { StoredOAuthTokens } from './oauth-storage.js';

const REFRESH_MARGIN_MS = 60_000;
const MAX_METADATA_BYTES = 256 * 1024;
type OAuthClientHeaders = { readonly authorization?: string };

const authorizationRequired = () => new ProtectedMcpError('authorization_required', { status: 409 });
const isFiniteNumber = (value: JsonValue | undefined): value is number => Number.isFinite(value);

const safeUrl = (value: JsonValue | undefined) => {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return url;
  } catch { return null; }
  return null;
};

export function createOAuth({ store, fetchImpl = fetch, now = Date.now, log = () => {} }: {
  readonly store: OAuthStore; readonly fetchImpl?: typeof fetch; readonly now?: () => number; readonly log?: OAuthLog;
}) {
  const refreshing = new Map<ConnectionId, Promise<StoredOAuthTokens>>();

  const getJson = async (url: string, init: RequestInit = {}): Promise<OAuthAnswer> => {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) throw new ProtectedMcpError('oauth_response_too_large', { status: 502 });
    let body: JsonValue = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body: oauthObject(body) };
  };

  const firstMetadata = async (candidates: readonly string[]) => {
    for (const candidate of candidates) {
      try {
        const { status, body } = await getJson(candidate, { headers: { accept: 'application/json' } });
        if (status === 200 && isPlainObject(body)) return body;
      } catch { continue; }
    }
    return null;
  };

  const discover = async (definition: HttpConnection): Promise<OAuthServer> => {
    const resource = new URL(definition.http.url);
    let issuer: JsonValue | undefined = definition.http.oauth?.issuer ?? null;
    if (!issuer) {
      const resourcePath = resource.pathname === '/' ? '' : resource.pathname;
      const metadata = await firstMetadata([
        `${resource.origin}/.well-known/oauth-protected-resource${resourcePath}`,
        `${resource.origin}/.well-known/oauth-protected-resource`,
      ]);
      issuer = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers[0] : null;
    }
    const issuerUrl = safeUrl(issuer);
    if (!issuerUrl) throw new ProtectedMcpError('oauth_discovery_failed', { status: 502 });
    const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
    const metadata = await firstMetadata([
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
    ]);
    const authorizationEndpoint = safeUrl(metadata?.authorization_endpoint);
    const tokenEndpoint = safeUrl(metadata?.token_endpoint);
    if (!metadata || !authorizationEndpoint || !tokenEndpoint) throw new ProtectedMcpError('oauth_discovery_failed', { status: 502 });
    return {
      issuer: issuerUrl.href,
      authorizationEndpoint: authorizationEndpoint.href,
      tokenEndpoint: tokenEndpoint.href,
      revocationEndpoint: safeUrl(metadata.revocation_endpoint)?.href ?? null,
      registrationEndpoint: safeUrl(metadata.registration_endpoint)?.href ?? null,
    };
  };

  const clientFor = async (definition: HttpConnection, server: OAuthServer, redirectUri: string): Promise<OAuthClient> => {
    if (definition.http.oauth?.clientId) return { clientId: definition.http.oauth.clientId, clientSecret: null, redirectUri };
    if (!server.registrationEndpoint) throw new ProtectedMcpError('oauth_client_required', { status: 400 });
    const { status, body } = await getJson(server.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'OpenChamber protected MCP',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if ((status !== 200 && status !== 201) || !isString(body?.client_id)) throw new ProtectedMcpError('oauth_registration_failed', { status: 502 });
    return { clientId: body.client_id, clientSecret: isString(body.client_secret) ? body.client_secret : null, redirectUri };
  };

  const clientAuthentication = (definition: StoredDefinition, credentials: { readonly secrets: Readonly<JsonObject>; readonly oauth: JsonObject }, form: URLSearchParams): OAuthClientHeaders => {
    const client = oauthObject(credentials.oauth.client);
    if (!client || !isString(client.clientId)) throw new ProtectedMcpError('oauth_client_required', { status: 400 });
    const configured = definition.transport === 'http' && definition.http.oauth?.clientSecret
      ? credentials.secrets[definition.http.oauth.clientSecret.secret]
      : null;
    const secret = isString(configured) ? configured : isString(client.clientSecret) ? client.clientSecret : null;
    form.set('client_id', client.clientId);
    if (!secret) return {};
    return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}` };
  };

  const tokenRequest = async (definition: HttpConnection, record: JsonObject, form: URLSearchParams) => {
    if (!isString(record.tokenEndpoint)) throw new ProtectedMcpError('oauth_discovery_failed', { status: 502 });
    const credentials = { secrets: store.credentialsFor(definition)?.secrets ?? {}, oauth: record };
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...clientAuthentication(definition, credentials, form) };
    return getJson(record.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  };

  const tokensFrom = (body: JsonObject | null, previous: StoredOAuthTokens | null): OAuthTokens | null => {
    if (!isString(body?.access_token) || (body.token_type && String(body.token_type).toLowerCase() !== 'bearer')) return null;
    return {
      accessToken: body.access_token,
      refreshToken: isString(body.refresh_token) ? body.refresh_token : previous?.refreshToken ?? null,
      expiresAt: isFiniteNumber(body.expires_in) ? now() + body.expires_in * 1000 : null,
      scope: isString(body.scope) ? body.scope : previous?.scope ?? null,
    };
  };

  const markUnauthorized = async (definition: HttpConnection, { tokens }: { readonly tokens: Pick<OAuthTokens, 'accessToken'> | null }) => {
    await store.updateOAuth(definition.id, destinationFingerprint(definition), (previous) => ({ ...oauthObject(previous), tokens: null }), {
      expect: (current) => oauthObject(current)?.tokens === tokens,
    });
  };

  const currentTokens = (definition: HttpConnection) => {
    const latest = oauthObject(store.credentialsFor(definition)?.oauth)?.tokens;
    if (isStoredOAuthTokens(latest) && latest.accessToken) return latest;
    throw authorizationRequired();
  };

  const refresh = async (definition: HttpConnection, record: JsonObject, grant: StoredOAuthTokens) => {
    if (!grant.refreshToken) {
      await markUnauthorized(definition, { tokens: grant });
      return currentTokens(definition);
    }
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, resource: definition.http.url });
    let answer;
    try {
      answer = await tokenRequest(definition, record, form);
    } catch {
      throw new ProtectedMcpError('oauth_refresh_failed', { status: 502 });
    }
    const tokens = answer.status === 200 ? tokensFrom(answer.body, grant) : null;
    if (!tokens) {
      if (answer.status === 400 || answer.status === 401) {
        log('oauth_refresh_rejected', { connection: definition.id });
        await markUnauthorized(definition, { tokens: grant });
        return currentTokens(definition);
      }
      throw new ProtectedMcpError('oauth_refresh_failed', { status: 502 });
    }
    const saved = await store.updateOAuth(definition.id, destinationFingerprint(definition), (previous) => ({ ...oauthObject(previous), tokens }), {
      expect: (current) => oauthObject(current)?.tokens === grant,
    });
    if (!saved) return currentTokens(definition);
    return tokens;
  };

  return {
    ...createOAuthAuthorization({ store, now, discover, clientFor, tokenRequest, tokensFrom, log }),

    async tokensFor(definition: HttpConnection, { refresh: force = false }: { readonly refresh?: boolean } = {}) {
      const record = oauthObject(store.credentialsFor(definition)?.oauth);
      const tokens = record?.tokens;
      if (!record || !isStoredOAuthTokens(tokens)) throw authorizationRequired();
      const fresh = tokens.expiresAt === null || (tokens.expiresAt !== undefined && tokens.expiresAt - now() > REFRESH_MARGIN_MS);
      if (fresh && !force) return tokens;
      const running = refreshing.get(definition.id);
      if (running) return running;
      const work = refresh(definition, record, tokens).finally(() => refreshing.delete(definition.id));
      refreshing.set(definition.id, work);
      return work;
    },

    markUnauthorized,

    async revokeUpstream(definition: StoredDefinition, credentials: OAuthCredentials | null) {
      const record = oauthObject(credentials?.oauth);
      const tokens = record?.tokens;
      if (!credentials || !isString(record?.revocationEndpoint) || !record.revocationEndpoint || !isStoredOAuthTokens(tokens)) return;
      for (const [token, hint] of [[tokens.refreshToken, 'refresh_token'], [tokens.accessToken, 'access_token']] as const) {
        if (!token) continue;
        const form = new URLSearchParams({ token, token_type_hint: hint });
        const { status } = await getJson(record.revocationEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...clientAuthentication(definition, { secrets: credentials.secrets, oauth: record }, form) },
          body: form.toString(),
        });
        if (status < 200 || status >= 300) log('oauth_revocation_failed', { connection: definition.id, code: 'oauth_revocation_rejected', status });
      }
    },
  };
}
