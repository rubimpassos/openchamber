import express from 'express';
import type { z } from 'zod';
import type { Router } from '../shared/http-contracts.js';
import { getProviderAuth, openCodeCredentialSource } from '../opencode/auth.js';
import { createHostProviders } from '../spaces/host-providers.js';
import type { HostProvidersOptions } from '../spaces/host-providers.js';
import {
  HOST_CREDENTIAL_ROUTE, MAX_HOST_CREDENTIAL_BYTES, listQuerySchema, providerQuerySchema,
  providerListSchema, providerReplySchema, secretNameSchema, secretQuerySchema, secretReplySchema, credentialsSchema, emptyQuerySchema, renewedLoginSchema, credentialSchema,
} from './host-credential-contract.js';

type CredentialReadResult = Awaited<ReturnType<ReturnType<typeof createHostProviders>['list' | 'read']>>
  | Awaited<ReturnType<ReturnType<typeof openCodeCredentialSource>['list']>>
  | { readonly value: string | null | undefined };

export interface HostCredentialRoutesOptions {
  readonly agentServer: boolean;
  readonly listProjectDirectories: () => Promise<readonly string[]>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readStoredKey?: HostProvidersOptions['readStoredKey'];
  readonly readLayers?: HostProvidersOptions['readLayers'];
  readonly credentialSource: Pick<ReturnType<typeof openCodeCredentialSource>, 'list' | 'create'>;
}

/** Mounted after API authentication, and only in the agent-server composition. */
export function registerHostCredentialRoutes(app: Router, {
  agentServer, listProjectDirectories, environment = process.env,
  readStoredKey = async (id) => {
    const auth = await getProviderAuth(id);
    return auth && 'key' in auth ? auth.key : null;
  },
  readLayers, credentialSource,
}: HostCredentialRoutesOptions) {
  if (!agentServer) return;
  const providers = () => createHostProviders({
    ...(readLayers ? { readLayers } : {}), readStoredKey,
    hostEnvironment: Object.fromEntries(Object.entries(environment).filter(([name]) => secretNameSchema.safeParse(name).success)),
  });
  const route = <Query extends Record<string, string>>(suffix: string, contract: {
    readonly query: z.ZodType<Query>;
    readonly reply: z.ZodType;
    readonly read: (query: Query) => CredentialReadResult | Promise<CredentialReadResult>;
  }) => app.get(`${HOST_CREDENTIAL_ROUTE}/${suffix}`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const parsed = contract.query.safeParse(Object.fromEntries(query));
    if ([...query.keys()].some((key) => query.getAll(key).length !== 1) || !parsed.success) {
      return res.status(400).json({ code: 'agent_host_credential_invalid_request' });
    }
    try {
      if (parsed.data.directory && !(await listProjectDirectories()).includes(parsed.data.directory)) {
        return res.status(403).json({ code: 'agent_project_not_registered' });
      }
      const result = contract.reply.safeParse(await contract.read(parsed.data));
      if (!result.success) return res.status(502).json({ code: 'agent_host_credential_invalid_response' });
      const body = JSON.stringify(result.data);
      if (Buffer.byteLength(body) > MAX_HOST_CREDENTIAL_BYTES) return res.status(502).json({ code: 'agent_response_too_large' });
      return res.type('json').send(body);
    } catch {
      return res.status(502).json({ code: 'agent_host_credential_unavailable' });
    }
  });
  route('providers', { query: listQuerySchema, reply: providerListSchema, read: ({ directory }) => providers().list(directory) });
  route('provider', { query: providerQuerySchema, reply: providerReplySchema, read: ({ provider, directory }) => providers().read(provider, directory) });
  route('secret', { query: secretQuerySchema, reply: secretReplySchema, read: ({ name }) => ({ value: Object.hasOwn(environment, name) ? environment[name] : null }) });
  // Keep the SDK's wire envelope; the public /api/credential route remains refused.
  route('credentials', { query: emptyQuerySchema, reply: credentialsSchema.transform((data) => ({ data })), read: () => credentialSource.list() });
  const parseRenewal = express.json({ limit: '256kb' });
  app.post(`${HOST_CREDENTIAL_ROUTE}/renewed-login`, (req, res, next) => {
    parseRenewal(req, res, (error) => error ? res.status(400).json({ code: 'agent_host_credential_invalid_request' }) : next());
  }, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const input = renewedLoginSchema.safeParse(req.body);
    if (!input.success || new URL(req.originalUrl, 'http://localhost').search) return res.status(400).json({ code: 'agent_host_credential_invalid_request' });
    try {
      const rows = credentialsSchema.parse(await credentialSource.list());
      const selected = rows.find((row) => row.integrationID === input.data.integrationID && row.active);
      if (selected?.value.type !== 'oauth' || selected.value.methodID !== input.data.value.methodID) {
        return res.status(409).json({ code: 'agent_login_not_selected' });
      }
      const row = credentialSchema.parse(await credentialSource.create(input.data));
      const body = JSON.stringify({ data: row });
      if (Buffer.byteLength(body) > MAX_HOST_CREDENTIAL_BYTES) return res.status(502).json({ code: 'agent_response_too_large' });
      return res.type('json').send(body);
    } catch { return res.status(502).json({ code: 'agent_host_credential_unavailable' }); }
  });
}
