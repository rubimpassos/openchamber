import { z } from 'zod';
import { BotServiceError, jiraOrigin, providerResult } from './contracts.js';
import type { JiraOAuthHttp } from './http.js';
import type { ResolvedBotCredential } from './credentials.js';

type JiraOAuthOptions = {
  readonly definition: { readonly site: string; readonly cloudId: string; readonly clientId: string; readonly clientSecret: string };
  readonly http?: JiraOAuthHttp | undefined;
  readonly resource: string;
  readonly assertCurrent: () => void | Promise<void>;
  readonly now: () => number;
};

const tenantSchema = z.object({ cloudId: z.uuid().toLowerCase() });
const tokenSchema = z.object({ access_token: z.string().min(1).max(32_768).regex(/^[\x21-\x7e]+$/),
  token_type: z.string().regex(/^Bearer$/i), expires_in: z.number().int().positive().max(86_400) });

export async function createJiraOAuthRequest({ definition, http, resource, assertCurrent, now }: JiraOAuthOptions): Promise<ResolvedBotCredential<'jira'>['request']> {
  if (!http) throw new BotServiceError('BOT_JIRA_OAUTH_UNAVAILABLE', 'Jira OAuth is unavailable on this server.');
  const site = jiraOrigin(definition.site);
  const tenant = providerResult(tenantSchema.safeParse(await http.readTenant({ site })));
  if (tenant.cloudId !== definition.cloudId) throw new BotServiceError('BOT_JIRA_CLOUD_MISMATCH', 'The Cloud ID does not belong to the selected Jira site.');
  let token: { readonly authorization: string; readonly expiresAt: number } | undefined;
  let renewal: Promise<string> | undefined;
  const authorization = async () => {
    await assertCurrent();
    if (token && token.expiresAt > now()) return token.authorization;
    if (!renewal) renewal = (async () => {
      const startedAt = now();
      let response: unknown;
      try { response = await http.exchangeToken({ clientId: definition.clientId, clientSecret: definition.clientSecret }); }
      catch (error) {
        if (!(error instanceof BotServiceError)) throw error;
        throw new BotServiceError('BOT_JIRA_OAUTH_AUTH_REQUIRED', 'Check the Jira OAuth credentials and scopes.', 'needs-you', error.status);
      }
      const result = providerResult(tokenSchema.safeParse(response));
      await assertCurrent();
      const lifetime = result.expires_in * 1_000;
      const expiresAt = startedAt + lifetime - Math.min(30_000, lifetime / 10);
      if (expiresAt <= now()) throw new BotServiceError('BOT_JIRA_OAUTH_AUTH_REQUIRED', 'The Jira access token expired before it could be used.');
      token = { authorization: `Bearer ${result.access_token}`, expiresAt };
      return token.authorization;
    })().finally(() => { renewal = undefined; });
    return renewal;
  };
  return async (input) => http.request({ ...input, site, cloudId: tenant.cloudId, resource,
    authorization: await authorization(), beforeWrite: async () => { await input.beforeWrite?.(); await assertCurrent(); } });
}
