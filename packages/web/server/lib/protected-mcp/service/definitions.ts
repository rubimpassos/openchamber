import { createHash } from 'node:crypto';
import { isBoolean, isPlainObject, isString } from '../../shared/guards.js';
import { assertNever, isConnectionName } from './contract.js';
import { parseHttp } from './definition-http.js';
import { parseStdio } from './definition-stdio.js';
import type { ConnectionDefinition, EnvironmentValue, HeaderValue, ToolPolicy } from './definition-types.js';
import type { JsonValue } from '../../shared/json-values.js';
import { fail, MAX_ITEMS, onlyKeys, plainText } from './definition-values.js';
export { LOOPBACK_HOSTS } from './definition-values.js';

const TOOL_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}\*?$/;
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MAX_TOOLS = 512;

function parseToolList(value: JsonValue | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOLS || !value.every((item: JsonValue): item is string => isString(item) && TOOL_PATTERN.test(item))) fail('invalid_definition', field);
  return [...new Set(value)];
}

function parsePolicy(value: JsonValue | undefined): ToolPolicy {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail('invalid_definition', 'policy');
  onlyKeys(value, ['allowTools', 'denyTools', 'defaultArguments'], 'policy');
  const allowTools = parseToolList(value.allowTools, 'policy.allowTools');
  const denyTools = parseToolList(value.denyTools, 'policy.denyTools');
  const result: { -readonly [Key in keyof ToolPolicy]: ToolPolicy[Key] } = {};
  if (allowTools) result.allowTools = allowTools;
  if (denyTools) result.denyTools = denyTools;
  if (value.defaultArguments !== undefined) {
    const defaults = value.defaultArguments;
    if (!isPlainObject(defaults) || Object.keys(defaults).length > MAX_ITEMS) fail('invalid_definition', 'policy.defaultArguments');
    const parsedDefaults: Record<string, string> = {};
    for (const [name, item] of Object.entries(defaults)) {
      if (!ARGUMENT_NAME.test(name)) fail('invalid_definition', `policy.defaultArguments.${name}`);
      parsedDefaults[name] = plainText(item, `policy.defaultArguments.${name}`, { max: 512 });
    }
    return { ...result, defaultArguments: parsedDefaults };
  }
  return result;
}

export function parseDefinition(input: JsonValue | undefined): ConnectionDefinition {
  if (!isPlainObject(input)) fail('invalid_definition');
  onlyKeys(input, ['name', 'enabled', 'transport', 'stdio', 'http', 'policy'], 'definition');
  if (!isConnectionName(input.name)) fail('invalid_name', 'name');
  if (input.enabled !== undefined && !isBoolean(input.enabled)) fail('invalid_definition', 'enabled');
  const base = { name: input.name, enabled: input.enabled !== false };
  switch (input.transport) {
    case 'stdio': {
      if (input.http !== undefined) fail('invalid_definition', 'http');
      const stdio = parseStdio(input.stdio);
      return { ...base, transport: 'stdio', stdio, policy: parsePolicy(input.policy) };
    }
    case 'http': {
      if (input.stdio !== undefined) fail('invalid_definition', 'stdio');
      const http = parseHttp(input.http);
      return { ...base, transport: 'http', http, policy: parsePolicy(input.policy) };
    }
    default:
      return fail('invalid_transport', 'transport');
  }
}

export function secretSlots(definition: ConnectionDefinition): string[] {
  const slots = new Set<string>();
  const collect = (value: EnvironmentValue | HeaderValue | undefined): void => {
    if (!isPlainObject(value)) return;
    if ('secret' in value && isString(value.secret)) slots.add(value.secret);
    if ('secretFile' in value && isString(value.secretFile)) slots.add(value.secretFile);
  };
  switch (definition.transport) {
    case 'stdio':
      Object.values(definition.stdio.env).forEach(collect);
      break;
    case 'http':
      Object.values(definition.http.headers).forEach(collect);
      collect(definition.http.oauth?.clientSecret);
      break;
    default:
      return assertNever(definition);
  }
  return [...slots].sort();
}

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue | undefined };

function canonicalJson(value: CanonicalValue | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return `${JSON.stringify(value)}`;
}

export function destinationFingerprint(definition: ConnectionDefinition): string {
  switch (definition.transport) {
    case 'stdio':
      return createHash('sha256').update(canonicalJson({ transport: 'stdio', command: definition.stdio.command, args: definition.stdio.args, env: definition.stdio.env })).digest('hex');
    case 'http':
      return createHash('sha256').update(canonicalJson({ transport: 'http', url: definition.http.url, headers: definition.http.headers, oauth: definition.http.oauth ?? null })).digest('hex');
    default:
      return assertNever(definition);
  }
}
