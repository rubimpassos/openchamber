import { createHash, randomBytes } from 'node:crypto';
import { assertNever, ProtectedMcpError } from './contract.js';
import type { ConnectionId } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { JsonObject } from '../../shared/json-values.js';
import type { openStore } from './store.js';
import { destinationFingerprint } from './definitions.js';
import { parseRedirectUri } from './oauth-redirect.js';
import { oauthGeneration, oauthObject } from './oauth-storage.js';

const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 16;
const random = (bytes: number) => randomBytes(bytes).toString('base64url');

export type HttpConnection = Extract<StoredDefinition, { transport: 'http' }>;
export type OAuthTokens = {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
  readonly scope: string | null;
};
export type OAuthServer = {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string | null;
  readonly registrationEndpoint: string | null;
};
export type OAuthClient = { readonly clientId: string; readonly clientSecret: string | null; readonly redirectUri: string };
export type OAuthRecord = OAuthServer & { readonly client: OAuthClient; readonly tokens: OAuthTokens | null; readonly generation?: number };
export type OAuthStore = Pick<Awaited<ReturnType<typeof openStore>>, 'get' | 'credentialsFor' | 'updateOAuth'>;
export type OAuthCredentials = NonNullable<ReturnType<OAuthStore['credentialsFor']>>;
export type OAuthLog = (event: string, fields: { readonly connection: ConnectionId; readonly code?: string; readonly status?: number }) => void;
export type OAuthAnswer = { readonly status: number; readonly body: JsonObject | null };
type TokenRequestRecord = OAuthServer & { readonly client: OAuthClient };
export type OAuthOutcome = 'authorized' | 'oauth_state_invalid' | 'oauth_denied' | 'oauth_connection_changed' | 'oauth_exchange_failed';
type Attempt = { readonly status: 'pending' } | { readonly status: 'done'; readonly outcome: OAuthOutcome };
type Pending = {
  readonly attempt: string; readonly id: ConnectionId; readonly revision: number; readonly fingerprint: string;
  readonly verifier: string; readonly redirectUri: string; readonly server: OAuthServer; readonly client: OAuthClient;
  readonly generation: number; readonly expires: number;
};
type AuthorizationOptions = {
  readonly store: OAuthStore;
  readonly now: () => number;
  readonly discover: (definition: HttpConnection) => Promise<OAuthServer>;
  readonly clientFor: (definition: HttpConnection, server: OAuthServer, redirectUri: string) => Promise<OAuthClient>;
  readonly tokenRequest: (definition: HttpConnection, record: TokenRequestRecord, form: URLSearchParams) => Promise<OAuthAnswer>;
  readonly tokensFrom: (body: JsonObject | null, previous: OAuthTokens | null) => OAuthTokens | null;
  readonly log: OAuthLog;
};

export function createOAuthAuthorization({ store, now, discover, clientFor, tokenRequest, tokensFrom, log }: AuthorizationOptions) {
  const pending = new Map<string, Pending>();
  const attempts = new Map<string, Attempt & { readonly expires: number }>();
  const expire = () => {
    for (const [state, entry] of pending) if (entry.expires <= now()) pending.delete(state);
    for (const [attempt, entry] of attempts) if (entry.expires <= now()) attempts.delete(attempt);
  };
  return {
    async start({ id, expectedRevision, redirectUri: supplied }: { readonly id: ConnectionId; readonly expectedRevision: number; readonly redirectUri: string }) {
      const callerUri = parseRedirectUri(supplied);
      const definition = store.get(id);
      if (!definition) throw new ProtectedMcpError('connection_not_found', { status: 404 });
      if (definition.revision !== expectedRevision) throw new ProtectedMcpError('revision_conflict', { status: 409 });
      if (definition.transport !== 'http' || !definition.http.oauth) throw new ProtectedMcpError('oauth_not_configured');
      const redirectUri = definition.http.oauth.redirectUri ?? callerUri;
      const generation = oauthGeneration(store.credentialsFor(definition)?.oauth);
      const server = await discover(definition);
      const client = await clientFor(definition, server, redirectUri);
      expire();
      if (pending.size >= MAX_PENDING) {
        for (const [state, evicted] of pending) {
          pending.delete(state);
          attempts.set(evicted.attempt, { status: 'done', outcome: 'oauth_state_invalid', expires: evicted.expires });
          break;
        }
      }
      const verifier = random(32);
      const state = random(32);
      const attempt = random(16);
      const expires = now() + PENDING_MS;
      pending.set(state, { attempt, id, revision: definition.revision, fingerprint: destinationFingerprint(definition), verifier, redirectUri, server, client, generation, expires });
      attempts.set(attempt, { status: 'pending', expires });
      const url = new URL(server.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (definition.http.oauth.scopes.length > 0) url.searchParams.set('scope', definition.http.oauth.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('resource', definition.http.url);
      return { attempt, url: url.href };
    },

    async complete({ state, code, error }: { readonly state: string; readonly code?: string | undefined; readonly error?: string | undefined }): Promise<{ readonly outcome: OAuthOutcome; readonly name: string | null }> {
      expire();
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry) return { outcome: 'oauth_state_invalid', name: null };
      const definition = store.get(entry.id);
      const name = definition?.name ?? null;
      const finish = (outcome: OAuthOutcome) => {
        if (entry.expires > now()) attempts.set(entry.attempt, { status: 'done', outcome, expires: entry.expires });
        return { outcome, name };
      };
      if (error !== undefined) return finish('oauth_denied');
      if (!definition || definition.transport !== 'http' || definition.revision !== entry.revision || destinationFingerprint(definition) !== entry.fingerprint) return finish('oauth_connection_changed');
      if (!code) return finish('oauth_state_invalid');
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier, resource: definition.http.url });
      let answer;
      try {
        answer = await tokenRequest(definition, { ...entry.server, client: entry.client }, form);
      } catch {
        return finish('oauth_exchange_failed');
      }
      const tokens = answer.status === 200 ? tokensFrom(answer.body, null) : null;
      if (!tokens) return finish('oauth_exchange_failed');
      const saved = await store.updateOAuth(definition.id, entry.fingerprint, (previous) => ({ ...oauthObject(previous), ...entry.server, client: entry.client, tokens, generation: entry.generation + 1 } satisfies OAuthRecord), {
        restart: true,
        expect: (current, latest) => latest.revision === entry.revision && oauthGeneration(current) === entry.generation,
      });
      if (saved) log('oauth_authorized', { connection: definition.id });
      return finish(saved ? 'authorized' : 'oauth_connection_changed');
    },

    attempt(id: string): Attempt | { readonly status: 'unknown' } {
      expire();
      const entry = attempts.get(id);
      if (!entry) return { status: 'unknown' };
      switch (entry.status) {
        case 'pending': return { status: 'pending' };
        case 'done': return { status: 'done', outcome: entry.outcome };
        default: return assertNever(entry);
      }
    },
  };
}
