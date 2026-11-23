import path from 'node:path';

import { isBoolean, isRecord, isString } from '../shared/guards.js';
import { SpaceError } from '../spaces/errors.js';
import type { HostdAssertion, HostdPlace, HostdSpaceId, HostdSpec, HostdToolsKey, ParsedHostdRequest } from './contracts.js';

export const MAX_FILL_BYTES = 64 * 1024 * 1024;
// Other C1 controls remain accepted, as in space labels; only NEL is refused.
const CONTROL_CHARACTERS = /(?![\u0080-\u0084\u0086-\u009f])[\p{Cc}\u2028\u2029]/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function invalid(field: string): never { throw new SpaceError('invalid_request', `Invalid hostd request field: ${field}`); }
// hostd parses every request on its one event loop, as root: each check here costs what a plain
// comparison costs, and a size limit comes before any look at the elements it bounds.
const objectOf = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) invalid(field);
  return value;
};
const text = (value: unknown, field: string, max = 1024): string => {
  if (!isString(value) || value.length === 0 || Buffer.byteLength(value) > max || CONTROL_CHARACTERS.test(value)) invalid(field);
  return value;
};
function fields(input: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  const value = objectOf(input, 'object');
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) invalid('fields');
  return value;
}
const integer = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
};
const isSpaceId = (value: unknown): value is HostdSpaceId => /^[0-9a-f]{12}$/.test(text(value, 'id', 12));
const isToolsKey = (value: unknown): value is HostdToolsKey => /^[0-9a-f]{16}$/.test(text(value, 'key', 16));
export const spaceId = (value: unknown): HostdSpaceId => isSpaceId(value) ? value : invalid('id');
export const toolsKey = (value: unknown): HostdToolsKey => isToolsKey(value) ? value : invalid('key');
const place = (value: unknown): HostdPlace => value === 'host' || value === 'host-root' ? value : invalid('place');

function command(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) invalid('argv');
  if (!value.every(isString) || value.some((arg) => arg.includes('\0')) || value[0] === '') invalid('argv');
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) invalid('argv size');
  return [...value];
}

function parseSpec(input: unknown): HostdSpec<HostdSpaceId> {
  const value = fields(input, ['id', 'name', 'project', 'created', 'memoryBytes', 'purpose'], ['id', 'name', 'project', 'created', 'memoryBytes']);
  const project = text(value.project, 'project', 16);
  const created = text(value.created, 'created', 32);
  if (!/^[0-9a-f]{16}$/.test(project) || !Number.isFinite(Date.parse(created)) || new Date(created).toISOString() !== created) invalid('project/created');
  const purpose = value.purpose ?? 'general';
  if (purpose !== 'general' && purpose !== 'pr-fix-loop-approval') invalid('purpose');
  const spec = { id: spaceId(value.id), name: text(value.name, 'name', 100), project, created, memoryBytes: integer(value.memoryBytes, 'memoryBytes', 64 * 1024 * 1024, 1024 ** 4) };
  return purpose === 'general' ? spec : { ...spec, purpose };
}

function startConfiguration(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const configuration = text(value, 'startConfig', 64 * 1024);
  let decoded: unknown;
  try { decoded = JSON.parse(configuration); } catch { invalid('startConfig JSON'); }
  const parsed = fields(decoded, ['providers']);
  const providers = objectOf(parsed.providers, 'providers');
  if (Object.keys(providers).length > 100) invalid('providers');
  for (const [id, entry] of Object.entries(providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) invalid('provider');
    const provider = fields(entry, ['settings']);
    const settings = fields(provider.settings, ['baseURL', 'apiKey']);
    if (settings.baseURL !== `http://gatekeeper:8080/model/${id}` || settings.apiKey !== 'space-window') invalid('provider settings');
  }
  return configuration;
}

export function parseRequest(input: unknown): ParsedHostdRequest {
  const value = objectOf(input, 'request');
  const op = text(value.op, 'op', 32);
  switch (op) {
    case 'check': fields(value, ['op']); return { op };
    case 'list': case 'disk': fields(value, ['op', 'place']); return { op, place: place(value.place) };
    case 'create': {
      fields(value, ['op', 'place', 'spec', 'startConfig', 'toolsKey', 'assertion'], ['op', 'place', 'spec', 'toolsKey']);
      const selected = place(value.place);
      return { op, spec: parseSpec(value.spec), startConfig: startConfiguration(value.startConfig), toolsKey: toolsKey(value.toolsKey), ...activationPlace(value, selected) };
    }
    case 'start': {
      fields(value, ['op', 'place', 'id', 'assertion'], ['op', 'place', 'id']);
      const selected = place(value.place);
      return { op, id: spaceId(value.id), ...activationPlace(value, selected) };
    }
    case 'stop': case 'remove': case 'verify':
      fields(value, ['op', 'place', 'id']); return { op, place: place(value.place), id: spaceId(value.id) };
    case 'exec': {
      fields(value, ['op', 'place', 'id', 'target', 'argv', 'timeoutMs', 'maxOutputBytes', 'keepTail'], ['op', 'place', 'id', 'target', 'argv']);
      if (value.target !== 'space' && value.target !== 'gatekeeper') throw new SpaceError('invalid_exec_target', 'A command runs in the space or gatekeeper');
      if (value.keepTail !== undefined && !isBoolean(value.keepTail)) invalid('keepTail');
      const keepTail = value.keepTail === true;
      return { op, place: place(value.place), id: spaceId(value.id), target: value.target, argv: command(value.argv), timeoutMs: integer(value.timeoutMs ?? 60_000, 'timeoutMs', 1, 4 * 3600_000), maxOutputBytes: integer(value.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes', 1, 128 * 1024 * 1024), keepTail };
    }
    case 'attach': {
      fields(value, ['op', 'place', 'id', 'argv'], ['op', 'place', 'id']);
      const request = { op: 'attach' as const, place: place(value.place), id: spaceId(value.id) };
      return value.argv === undefined ? request : { ...request, argv: command(value.argv) };
    }
    case 'tools-ensure': {
      fields(value, ['op', 'key', 'input']);
      const input = value.input;
      if (input !== null && (!isString(input) || input.length > Math.ceil(MAX_FILL_BYTES / 3) * 4 || !BASE64.test(input))) invalid('input');
      return { op, key: toolsKey(value.key), input };
    }
    case 'tools-prune':
      fields(value, ['op', 'keep']);
      if (!Array.isArray(value.keep) || value.keep.length > 16384) invalid('keep');
      return { op, keep: value.keep.map(toolsKey) };
    case 'root-status': case 'project-shares':
      fields(value, ['op']);
      return { op };
    case 'root-approval-challenge':
      fields(value, ['op', 'code']);
      return { op, code: text(value.code, 'code', 16) };
    case 'root-approval-complete': {
      fields(value, ['op', 'code', 'credential', 'response', 'label'], ['op', 'code', 'credential', 'response']);
      const credential = fields(value.credential, ['id', 'publicKey', 'rpID']);
      const request = {
        op: 'root-approval-complete' as const,
        code: text(value.code, 'code', 16),
        credential: { id: text(credential.id, 'credential id', 1366), publicKey: text(credential.publicKey, 'credential key', 2048), rpID: text(credential.rpID, 'credential rpID', 255) },
        response: assertionOf(value.response),
      };
      return value.label === undefined ? request : { ...request, label: text(value.label, 'label', 480) };
    }
    case 'root-activation-options':
      if (value.action === 'create') {
        fields(value, ['op', 'action', 'spec']);
        return { op, action: 'create', spec: activationSpec(value.spec) };
      }
      fields(value, ['op', 'action', 'id']);
      if (value.action !== 'start') invalid('action');
      return { op, action: 'start', id: spaceId(value.id) };
    case 'share-project': case 'unshare-project': case 'project-owner': {
      fields(value, ['op', 'path']);
      const projectPath = text(value.path, 'path', 4096);
      if (!path.isAbsolute(projectPath) || path.normalize(projectPath) !== projectPath) invalid('path');
      return { op, path: projectPath };
    }
    default: invalid('op');
  }
}

const base64url = (value: unknown, field: string, max: number): string => {
  const encoded = text(value, field, max);
  return /^[A-Za-z0-9_-]+$/.test(encoded) ? encoded : invalid(field);
};

/** A WebAuthn assertion as @simplewebauthn/browser hands it over; the root operations check its signature. */
function assertionOf(input: unknown): HostdAssertion {
  const value = fields(input, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'], ['id', 'rawId', 'type', 'response']);
  if (value.type !== 'public-key') invalid('assertion type');
  const response = fields(value.response, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'], ['clientDataJSON', 'authenticatorData', 'signature']);
  const extensions = objectOf(value.clientExtensionResults ?? {}, 'assertion extensions');
  if (JSON.stringify(extensions).length > 4096) invalid('assertion extensions');
  const attachment = value.authenticatorAttachment;
  if (attachment !== undefined && attachment !== 'platform' && attachment !== 'cross-platform') invalid('assertion attachment');
  const id = base64url(value.id, 'assertion id', 2048);
  const rawId = base64url(value.rawId, 'assertion rawId', 2048);
  const signed = {
    clientDataJSON: base64url(response.clientDataJSON, 'clientDataJSON', 16_384),
    authenticatorData: base64url(response.authenticatorData, 'authenticatorData', 16_384),
    signature: base64url(response.signature, 'signature', 4096),
  };
  return {
    id, rawId, type: 'public-key',
    response: { ...signed, ...(response.userHandle === undefined ? {} : { userHandle: base64url(response.userHandle, 'userHandle', 1024) }) },
    clientExtensionResults: extensions,
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
  };
}

// Only a root space's create and start carry a passkey assertion.
const activationPlace = (value: Record<string, unknown>, selected: HostdPlace): { readonly place: 'host'; readonly assertion?: never } | { readonly place: 'host-root'; readonly assertion?: HostdAssertion } => {
  if (value.assertion === undefined) return { place: selected };
  if (selected !== 'host-root') invalid('assertion');
  return { place: selected, assertion: assertionOf(value.assertion) };
};

/** What the confirmation of a root creation is bound to: the spec without its creation time. */
function activationSpec(input: unknown): Omit<HostdSpec<HostdSpaceId>, 'created'> {
  const value = fields(input, ['id', 'name', 'project', 'memoryBytes', 'purpose'], ['id', 'name', 'project', 'memoryBytes']);
  const project = text(value.project, 'project', 16);
  if (!/^[0-9a-f]{16}$/.test(project)) invalid('project');
  const purpose = value.purpose ?? 'general';
  if (purpose !== 'general' && purpose !== 'pr-fix-loop-approval') invalid('purpose');
  const spec = { id: spaceId(value.id), name: text(value.name, 'name', 100), project, memoryBytes: integer(value.memoryBytes, 'memoryBytes', 64 * 1024 * 1024, 1024 ** 4) };
  return purpose === 'general' ? spec : { ...spec, purpose };
}
