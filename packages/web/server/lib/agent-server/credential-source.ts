import type { z } from 'zod';
import type { CredentialCreateInput, CredentialEntry } from '@opencode/client';
import { openCodeCredentialSource } from '../opencode/auth.js';
import type { CredentialSource, OAuthCreateInput, OAuthEntry } from '../opencode/auth.js';
import { SpaceError } from '../spaces/errors.js';
import type { AgentUpstream } from './agent-upstream.js';
import { HOST_CREDENTIAL_ROUTE, credentialSchema, credentialsSchema } from './host-credential-contract.js';
import type { HostCredential } from './host-credential-contract.js';

// Zod's optional metadata includes explicit undefined; the SDK models omission.
const sdkCredential = ({ value, ...entry }: HostCredential) => {
  const { metadata, ...fields } = value;
  return { ...entry, value: metadata === undefined ? fields : { ...fields, metadata } };
};
const sdkCredentialSchema = credentialSchema.transform(sdkCredential);
const sdkCredentialsSchema = credentialsSchema.transform((rows) => rows.map(sdkCredential));

/** The SDK preserves requests; the agent transport supplies auth, size and time bounds. */
export function createAgentCredentialSource(upstream: Pick<AgentUpstream, 'origin' | 'fetch'>) {
  const source = openCodeCredentialSource({
    buildOpenCodeUrl: () => upstream.origin, getOpenCodeAuthHeaders: () => ({}),
    fetch: (input, options) => {
      const { body, ...init } = options ?? {};
      const requestInit: RequestInit = init;
      if (body !== undefined) requestInit.body = body;
      const request = new Request(input, requestInit);
      const url = new URL(request.url);
      // OpenChamber deliberately refuses the public credential-list proxy.
      if (url.pathname === '/api/credential' && request.method === 'GET') url.pathname = `${HOST_CREDENTIAL_ROUTE}/credentials`;
      if (url.pathname === '/api/credential' && request.method === 'POST') url.pathname = `${HOST_CREDENTIAL_ROUTE}/renewed-login`;
      return upstream.fetch(new Request(url, request));
    },
  });
  const checked = async <Schema extends z.ZodType>(operation: () => Promise<CredentialEntry | CredentialEntry[]>, schema: Schema): Promise<z.output<Schema>> => {
    try {
      const result = schema.safeParse(await operation());
      if (!result.success) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.');
      return result.data;
    } catch (error) {
      const code = error instanceof SpaceError ? error.code : 'agent_host_credential_unavailable';
      throw new SpaceError(code, code);
    }
  };
  function create(input: OAuthCreateInput): Promise<OAuthEntry>;
  function create(input: CredentialCreateInput): Promise<CredentialEntry>;
  async function create(input: CredentialCreateInput | OAuthCreateInput): Promise<OAuthEntry> {
    const row = await checked(() => {
      const { metadata, ...value } = input.value;
      return source.create({ ...input, value: metadata === undefined ? value : { ...value, metadata } });
    }, sdkCredentialSchema);
    const methodID = 'methodID' in input.value ? input.value.methodID : undefined;
    if (row.integrationID !== input.integrationID || row.value.type !== 'oauth' || row.value.methodID !== methodID || !row.active) {
      throw new SpaceError('agent_host_credential_invalid_response', 'Invalid renewed login identity.');
    }
    return { ...row, value: row.value };
  }
  return {
    list: () => checked(source.list, sdkCredentialsSchema),
    create,
    remove: async (id: string) => {
      try { return await source.remove(id); }
      catch { throw new SpaceError('agent_host_credential_unavailable', 'Agent credential removal failed.'); }
    },
  } satisfies CredentialSource;
}
