import { isBoolean, isNumber, isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError, isConnectionId } from './contract.js';
import type { ConnectionId } from './contract.js';
import { parseDefinition } from './definitions.js';
import type { ConnectionDefinition } from './definition-types.js';
import type { JsonValue } from '../../shared/json-values.js';

type Secrets = Readonly<Record<string, string>>;
type ExistingConnection = { readonly id: ConnectionId; readonly expectedRevision: number };
type DefinitionOperation = { readonly definition: ConnectionDefinition; readonly secrets: Secrets };
export type StoreOperation =
  | ({ readonly kind: 'create' } & DefinitionOperation)
  | ({ readonly kind: 'update' } & ExistingConnection & DefinitionOperation)
  | ({ readonly kind: 'set-enabled'; readonly enabled: boolean } & ExistingConnection)
  | ({ readonly kind: 'remove' | 'revoke-credentials' } & ExistingConnection);

const MAX_SECRET_LENGTH = 64 * 1024;
const parseSecrets = (value: JsonValue | undefined) => {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ProtectedMcpError('invalid_request', { message: 'secrets' });
  const secrets: Record<string, string> = {};
  for (const [slot, secret] of Object.entries(value)) {
    if (!isString(secret) || secret.length === 0 || secret.length > MAX_SECRET_LENGTH) {
      throw new ProtectedMcpError('invalid_secret', { message: `invalid_secret: ${slot}` });
    }
    secrets[slot] = secret;
  }
  return secrets;
};

export function parseOperation(value: JsonValue | undefined): StoreOperation {
  if (!isPlainObject(value) || !isString(value.kind)) throw new ProtectedMcpError('invalid_request', { message: 'operation' });
  const existing = (): ExistingConnection => {
    if (!isConnectionId(value.id) || !isNumber(value.expectedRevision) || !Number.isSafeInteger(value.expectedRevision)) {
      throw new ProtectedMcpError('invalid_request', { message: 'id and expectedRevision' });
    }
    return { id: value.id, expectedRevision: value.expectedRevision };
  };
  switch (value.kind) {
    case 'create':
      return { kind: 'create', definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'update':
      return { kind: 'update', ...existing(), definition: parseDefinition(value.definition), secrets: parseSecrets(value.secrets) };
    case 'set-enabled':
      if (!isBoolean(value.enabled)) throw new ProtectedMcpError('invalid_request', { message: 'enabled' });
      return { kind: 'set-enabled', ...existing(), enabled: value.enabled };
    case 'remove':
    case 'revoke-credentials':
      return { kind: value.kind, ...existing() };
    default:
      throw new ProtectedMcpError('invalid_request', { message: 'kind' });
  }
}
