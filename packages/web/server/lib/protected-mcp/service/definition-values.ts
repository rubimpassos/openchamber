import path from 'node:path';
import { isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';

const SLOT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
export const MAX_ITEMS = 64;

export function fail(code: string, field?: string): never {
  throw new ProtectedMcpError(code, { message: field ? `${code}: ${field}` : code });
}

export function plainText(value: JsonValue | undefined, field: string, { max = 4096 }: { readonly max?: number } = {}): string {
  if (!isString(value) || value.length > max || value.includes('\0')) fail('invalid_definition', field);
  return value;
}

export function relativeStatePath(value: JsonValue | undefined, field: string): string {
  const text = plainText(value, field, { max: 512 });
  const normalized = path.posix.normalize(text);
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) fail('invalid_state_path', field);
  return normalized;
}

export function slotReference(value: Readonly<JsonObject>, key: string, field: string): string {
  const slot = value[key];
  if (!isString(slot) || !SLOT.test(slot)) fail('invalid_secret_slot', field);
  return slot;
}

export function onlyKeys(value: Readonly<JsonObject>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('invalid_definition', `${field}.${key}`);
  }
}

export function parseUrl(value: JsonValue | undefined, field: string): string {
  let url: URL;
  try {
    url = new URL(plainText(value, field, { max: 2048 }));
  } catch (error) {
    if (error instanceof TypeError || error instanceof ProtectedMcpError) return fail('invalid_url', field);
    throw error;
  }
  if (url.username || url.password || url.hash) fail('insecure_url', field);
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  return fail('insecure_url', field);
}
