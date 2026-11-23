import { z } from 'zod';
import { SpaceError, spaceErrorProperty } from '../spaces/errors.js';
import { readBoundedBody } from './agent-upstream.js';
import type { AgentUpstream } from './agent-upstream.js';
import {
  HOST_CREDENTIAL_ROUTE, MAX_HOST_CREDENTIAL_BYTES, listQuerySchema, providerQuerySchema,
  providerListSchema, providerReplySchema, secretQuerySchema, secretReplySchema,
} from './host-credential-contract.js';

const failureCode = z.enum([
  'agent_host_credential_invalid_request', 'agent_project_not_registered',
  'agent_host_credential_invalid_response', 'agent_host_credential_unavailable',
  'agent_response_too_large', 'agent_unreachable', 'agent_login_failed',
  'agent_session_expired', 'agent_redirected',
]).catch('agent_host_credential_unavailable');
const failureReply = z.object({ code: failureCode }).catch({ code: 'agent_host_credential_unavailable' });

export function createAgentHostCredentials(upstream: Pick<AgentUpstream, 'request'>) {
  const queryOf = <Schema extends z.ZodType<Record<string, string>>>(schema: Schema, value: z.input<Schema>): z.output<Schema> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SpaceError('agent_host_credential_invalid_request', 'Invalid agent credential request.');
    return parsed.data;
  };
  const read = async <Schema extends z.ZodType>(suffix: 'providers' | 'provider' | 'secret', query: Record<string, string>, schema: Schema): Promise<z.output<Schema>> => {
    try {
      const response = await upstream.request({
        path: `${HOST_CREDENTIAL_ROUTE}/${suffix}?${new URLSearchParams(query)}`,
        headers: { accept: 'application/json' }, timeoutMs: 5000,
      });
      const body = await readBoundedBody(response, MAX_HOST_CREDENTIAL_BYTES);
      let value;
      try { value = JSON.parse(body); } catch { throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.'); }
      if (response.statusCode !== 200) {
        const { code } = failureReply.parse(value);
        throw new SpaceError(code, code);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent credential response.');
      return parsed.data;
    } catch (error) {
      const code = failureCode.parse(spaceErrorProperty(error, 'code'));
      throw new SpaceError(code, code);
    }
  };
  return {
    hostProviders: {
      list: async (directory: string | null) => read('providers', queryOf(listQuerySchema, { directory: directory ?? '' }), providerListSchema),
      read: async (provider: string, directory: string | null) => {
        const result = await read('provider', queryOf(providerQuerySchema, { provider, directory: directory ?? '' }), providerReplySchema);
        if (result !== null && result.id !== provider) throw new SpaceError('agent_host_credential_invalid_response', 'Invalid agent provider identity.');
        return result;
      },
    },
    readHostSecret: async (name: string) => (await read('secret', queryOf(secretQuerySchema, { name }), secretReplySchema)).value ?? undefined,
  };
}
