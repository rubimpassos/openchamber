import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import type { StoredDefinition } from './definition-types.js';
import type { JsonValue } from '../../shared/json-values.js';

declare const connectionIdBrand: unique symbol;
declare const connectionNameBrand: unique symbol;
export type ConnectionId = string & { readonly [connectionIdBrand]: true };
export type ConnectionName = string & { readonly [connectionNameBrand]: true };
export type CredentialState = 'none' | 'stored' | 'missing' | 'authorized' | 'authorization_required';
export type Finding = {
  readonly code: string;
  readonly level: 'error' | 'unknown' | 'warning';
  readonly subject?: string;
};
export type Enforcement = {
  readonly status: 'protected' | 'unprotected' | 'unverified';
  readonly checkedAt: number;
  readonly findings: readonly Finding[];
};
type StatusInput = {
  readonly version: string;
  readonly administration: 'shared' | 'separate';
  readonly enforcement: Enforcement;
  readonly connections: readonly { readonly definition: StoredDefinition; readonly credential: CredentialState }[];
};
type EngineFrameResult =
  | { readonly ok: false; readonly code: 'malformed_frame' | 'unsupported_request' | 'protocol_mismatch' }
  | { readonly ok: true; readonly frame: { readonly type: 'status' } | { readonly type: 'hello'; readonly connection: ConnectionId } };

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const CONNECTION_ID = /^pmcp_[0-9a-f]{16}$/;
const CONNECTION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const MAX_FINDINGS = 50;

export class ProtectedMcpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, { status = 400, message = code }: { readonly status?: number; readonly message?: string } = {}) {
    super(message);
    this.name = 'ProtectedMcpError';
    this.code = code;
    this.status = status;
  }
}

export const isConnectionId = (value: unknown): value is ConnectionId => isString(value) && CONNECTION_ID.test(value);
export const isConnectionName = (value: unknown): value is ConnectionName => isString(value) && CONNECTION_NAME.test(value);

const malformed = { ok: false, code: 'malformed_frame' } as const;

export function parseEngineFrame(line: string): EngineFrameResult {
  if (!isString(line) || Buffer.byteLength(line) > MAX_FRAME_BYTES) return malformed;
  let value: JsonValue;
  try {
    value = JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return malformed;
    throw error;
  }
  if (!isPlainObject(value) || !isString(value.type)) return malformed;
  const keys = Object.keys(value).sort().join(',');
  if (value.type === 'status') {
    return keys === 'type' ? { ok: true, frame: { type: 'status' } } : malformed;
  }
  if (value.type !== 'hello') return { ok: false, code: 'unsupported_request' };
  if (keys !== 'connection,protocol,type') return malformed;
  if (value.protocol !== PROTOCOL_VERSION) return { ok: false, code: 'protocol_mismatch' };
  if (!isConnectionId(value.connection)) return malformed;
  return { ok: true, frame: { type: 'hello', connection: value.connection } };
}

function targetSummary(definition: StoredDefinition) {
  switch (definition.transport) {
    case 'http': {
      const url = new URL(definition.http.url);
      return { kind: 'url', label: `${url.origin}${url.pathname}` };
    }
    case 'stdio': {
      const { command } = definition.stdio;
      if (isString(command)) return { kind: 'command', label: path.basename(command) };
      return { kind: 'package', label: `${command.package}@${command.version}` };
    }
    default:
      return assertNever(definition);
  }
}

const publicFinding = (finding: Finding): Finding => {
  const result = { code: finding.code, level: finding.level };
  if (isString(finding.subject)) return { ...result, subject: finding.subject };
  return result;
};

export function assertNever(_value: never): never {
  throw new ProtectedMcpError('internal_error', { status: 500 });
}

export function toPublicStatus({ version, administration, enforcement, connections }: StatusInput) {
  return {
    protocol: PROTOCOL_VERSION,
    service: { version },
    enforcement: {
      status: enforcement.status,
      checkedAt: enforcement.checkedAt,
      findings: enforcement.findings.slice(0, MAX_FINDINGS).map(publicFinding),
    },
    administration,
    connections: connections.map(({ definition, credential }) => ({
      id: definition.id,
      name: definition.name,
      revision: definition.revision,
      enabled: definition.enabled,
      transport: definition.transport,
      target: targetSummary(definition),
      credential,
    })),
  };
}
