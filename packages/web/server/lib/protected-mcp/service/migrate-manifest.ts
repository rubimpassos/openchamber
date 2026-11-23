import path from 'node:path';
import { isPlainObject, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import type { ConnectionId } from './contract.js';
import { parseDefinition, secretSlots } from './definitions.js';
import type { ConnectionDefinition } from './definition-types.js';

export type CredentialSource = { readonly envFile: string; readonly key: string } | { readonly file: string };
type StateFile = { readonly from: string; readonly to: string };
type Selection = Readonly<JsonObject> & { readonly connection: ConnectionId; readonly name: string; readonly scope: 'project' | 'global' };
export type ManifestConnection = {
  readonly id: ConnectionId; readonly source: JsonValue; readonly definition: ConnectionDefinition;
  readonly credentials: Readonly<Record<string, CredentialSource>>; readonly stateFiles: readonly StateFile[]; readonly expectedTools: readonly string[] | null;
};
export type MigrationManifest = { readonly connections: readonly ManifestConnection[]; readonly selections: readonly Selection[] };

const SOURCE = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/;
const PROJECT_PATH = (value: JsonValue | undefined) => isString(value) && path.isAbsolute(value) && !value.includes('\0');
const object = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
export function fail(code: string, message?: string): never {
  throw new ProtectedMcpError(code, { status: 400, message: message ?? code });
}

function requireCredentialSources(value: JsonObject, slots: readonly string[], field: string): asserts value is JsonObject & Readonly<Record<string, CredentialSource>> {
  for (const slot of slots) {
    const from = value[slot];
    const valid = object(from) && (
      (isString(from.envFile) && path.isAbsolute(from.envFile) && isString(from.key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(from.key) && Object.keys(from).length === 2)
      || (isString(from.file) && path.isAbsolute(from.file) && Object.keys(from).length === 1));
    if (!valid) fail('invalid_manifest', `${field}.${slot}`);
  }
}

export function parseManifest(value: JsonValue | undefined): MigrationManifest {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.connections)) fail('invalid_manifest', 'version 1 with a connections list');
  const ids = new Set<ConnectionId>();
  const names = new Set<string>();
  const connections = value.connections.map((entry, index): ManifestConnection => {
    if (!object(entry)) fail('invalid_manifest', `connections.${index}`);
    if (!isConnectionId(entry.id) || ids.has(entry.id)) fail('invalid_manifest', `connections.${index}.id`);
    if (!SOURCE.test(String(entry.source ?? ''))) fail('invalid_manifest', `connections.${index}.source`);
    const definition = parseDefinition(entry.definition);
    if (names.has(definition.name)) fail('invalid_manifest', `connections.${index}.definition.name`);
    ids.add(entry.id);
    names.add(definition.name);
    const slots = secretSlots(definition);
    const sources = entry.credentials ?? {};
    if (!object(sources)) fail('invalid_manifest', `connections.${index}.credentials`);
    for (const slot of Object.keys(sources)) if (!slots.includes(slot)) fail('invalid_manifest', `connections.${index}.credentials.${slot}`);
    requireCredentialSources(sources, slots, `connections.${index}.credentials`);
    if (entry.expectedTools !== undefined && (!Array.isArray(entry.expectedTools) || !entry.expectedTools.every(isString))) {
      fail('invalid_manifest', `connections.${index}.expectedTools`);
    }
    const files = entry.stateFiles ?? [];
    if (!Array.isArray(files)) fail('invalid_manifest', `connections.${index}.stateFiles`);
    const stateFiles = files.map((file, fileIndex): StateFile => {
      const target = object(file) && isString(file.to) ? path.posix.normalize(file.to) : '';
      if (!object(file) || !isString(file.from) || !path.isAbsolute(file.from) || !target
        || path.posix.isAbsolute(target) || target === '..' || target.startsWith('../') || Object.keys(file).length !== 2 || !isString(file.to)) {
        fail('invalid_manifest', `connections.${index}.stateFiles.${fileIndex}`);
      }
      return { from: file.from, to: file.to };
    });
    return { id: entry.id, source: entry.source ?? null, definition, credentials: sources, stateFiles, expectedTools: entry.expectedTools ?? null };
  });
  const selected = value.selections ?? [];
  if (!Array.isArray(selected)) fail('invalid_manifest', 'selections');
  const selections = selected.map((selection, index): Selection => {
    if (!object(selection) || !isConnectionId(selection.connection) || !ids.has(selection.connection) || !isString(selection.name)) fail('invalid_manifest', `selections.${index}`);
    if (selection.scope !== 'project' && selection.scope !== 'global') fail('invalid_manifest', `selections.${index}.scope`);
    if (selection.scope === 'project' && !PROJECT_PATH(selection.project)) fail('invalid_manifest', `selections.${index}.scope`);
    return { ...selection, connection: selection.connection, name: selection.name, scope: selection.scope };
  });
  return { connections, selections };
}
