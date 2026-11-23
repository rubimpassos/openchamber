import { assertBotWriteAllowed } from '../../enterprise-mode.js';
import type { BotDestination, EnterprisePolicyOptions } from '../../enterprise-mode.js';
import { z } from 'zod';
import { BotServiceError, jiraOrigin, parse } from './contracts.js';
import type { BotService } from './contracts.js';
import type { JsonValue } from '../../shared/json-values.js';

export type ProviderHttpOptions = {
  readonly fetchImpl?: ((url: string, options: RequestInit) => Promise<Response>) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly policyOptions?: EnterprisePolicyOptions | undefined;
};
export type ProviderRequest = {
  readonly path: string;
  readonly authorization?: string | undefined;
  readonly method?: string | undefined;
  readonly body?: unknown;
  readonly beforeWrite?: (() => void | Promise<void>) | undefined;
  readonly readOnly?: boolean | undefined;
};
export type ProviderRequestInput = ProviderRequest & BotDestination;
export type ProviderHttp = (input: ProviderRequestInput) => Promise<JsonValue>;
export type JiraOAuthRequestInput = Omit<ProviderRequest, 'readOnly'> & {
  readonly site: string;
  readonly cloudId: string;
  readonly resource: string;
};
export type JiraOAuthHttp = {
  readonly readTenant: (input: { readonly site: string }) => Promise<JsonValue>;
  readonly exchangeToken: (input: { readonly clientId: string; readonly clientSecret: string }) => Promise<JsonValue>;
  readonly request: (input: JiraOAuthRequestInput) => Promise<JsonValue>;
};
type BoundedRequest = {
  readonly url: URL;
  readonly service?: BotService | undefined;
  readonly authorization?: string | undefined;
  readonly method?: string | undefined;
  readonly write?: boolean | undefined;
} & ({ readonly form: true; readonly body: string } | { readonly form?: false; readonly body?: unknown });

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const providerUrl = (origin: string, path: string): URL => {
  const url = new URL(path, origin);
  if (url.origin !== origin || !path.startsWith('/') || path.startsWith('//') || url.hash
    || url.username || url.password || url.protocol !== 'https:') {
    throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'The provider destination is invalid.', 'failed', 400);
  }
  return url;
};
const allowWrite = (destination: BotDestination, policyOptions: EnterprisePolicyOptions | undefined): void => {
  try { assertBotWriteAllowed(destination, policyOptions); }
  catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot destination.', 'needs-you', 403); }
};

/** Private bounded transport. Callers own fixed URLs and content-write admission. */
const createBoundedRequest = ({ fetchImpl = fetch, timeoutMs = 15_000 }: ProviderHttpOptions = {}) => {
  return async (input: BoundedRequest): Promise<JsonValue> => {
    const { url, service, authorization, method = 'GET', write = false, form = false } = input;
    let response;
    try {
      const headers: Record<string, string> = { Accept: 'application/json',
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'User-Agent': 'OpenChamber-Bots',
      };
      const options: RequestInit = {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers,
      };
      if (authorization) headers.Authorization = authorization;
      if (service === 'github') headers['X-GitHub-Api-Version'] = '2026-03-10';
      if (input.body !== undefined) options.body = input.form ? input.body : JSON.stringify(input.body);
      response = await fetchImpl(url.href, options);
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new BotServiceError('BOT_SERVICE_REDIRECT', 'The provider refused the fixed destination.', write ? 'outcome-unknown' : 'needs-you');
      }
      if (!response.ok) {
        await response.body?.cancel();
        const auth = response.status === 401 || response.status === 403;
        throw new BotServiceError(auth ? 'BOT_SERVICE_AUTH_REQUIRED' : 'BOT_SERVICE_REJECTED',
          auth ? 'Reconnect or authorize the selected bot identity.' : 'The provider refused the bot operation.',
          auth ? 'needs-you' : response.status >= 500 && write ? 'outcome-unknown' : 'failed', response.status);
      }
      if (response.status === 204) return null;
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof BotServiceError) throw error;
      throw new BotServiceError('BOT_SERVICE_UNAVAILABLE', 'The provider response is unavailable.', write ? 'outcome-unknown' : 'needs-you', 502);
    }
  };
};

/** Fixed-origin, bounded requests. Provider bodies never enter errors or logs. */
export function createProviderHttp(options: ProviderHttpOptions = {}): ProviderHttp {
  const request = createBoundedRequest(options);
  return async ({ service, origin, resource, path, authorization, method = 'GET', body, beforeWrite, readOnly = false }) => {
    const url = providerUrl(origin, path);
    const write = method !== 'GET' && !readOnly;
    if (write) {
      await beforeWrite?.();
      allowWrite({ service, origin, resource }, options.policyOptions);
    }
    return request({ url, service, authorization, method, body, write });
  };
}

/** The shared gateway retains the verified Jira site's policy authority. */
export function createJiraOAuthHttp(options: ProviderHttpOptions = {}): JiraOAuthHttp {
  const request = createBoundedRequest(options);
  return {
    readTenant: ({ site }) => request({ url: providerUrl(jiraOrigin(site), '/_edge/tenant_info') }),
    exchangeToken: ({ clientId, clientSecret }) => request({
      url: new URL('https://auth.atlassian.com/oauth/token'), method: 'POST', form: true,
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
    }),
    async request({ site, cloudId, resource, path, authorization, method = 'GET', body, beforeWrite }) {
      const origin = jiraOrigin(site);
      const tenant = parse(z.uuid().safeParse(cloudId)).toLowerCase();
      const url = providerUrl('https://api.atlassian.com', `/ex/jira/${tenant}${path}`);
      if (!path.startsWith('/rest/api/3/') || path.includes('\\') || !url.pathname.startsWith(`/ex/jira/${tenant}/rest/api/3/`)) {
        throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'The Jira gateway destination is invalid.', 'failed', 400);
      }
      const write = method !== 'GET';
      if (write) {
        await beforeWrite?.();
        allowWrite({ service: 'jira', origin, resource }, options.policyOptions);
      }
      return request({ url, service: 'jira', authorization, method, body, write });
    },
  };
}
