import { isPlainObject, isString } from '../../shared/guards.js';
import type { HeaderValue, HttpDefinition, OAuthDefinition } from './definition-types.js';
import { fail, MAX_ITEMS, onlyKeys, parseUrl, plainText, slotReference } from './definition-values.js';
import { parseRedirectUri } from './oauth-redirect.js';
import type { JsonValue } from '../../shared/json-values.js';

type MutableOAuthDefinition = { -readonly [Key in keyof OAuthDefinition]: OAuthDefinition[Key] };

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const OAUTH_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
]);

function parseHeaderValue(value: JsonValue | undefined, field: string): HeaderValue {
  const noLineBreak = (text: string): string => {
    if (/[\r\n]/.test(text)) fail('invalid_definition', field);
    return text;
  };
  if (isString(value)) return noLineBreak(plainText(value, field));
  if (!isPlainObject(value)) fail('invalid_definition', field);
  onlyKeys(value, ['secret', 'prefix'], field);
  const result = { secret: slotReference(value, 'secret', field) };
  if (value.prefix !== undefined) return { ...result, prefix: noLineBreak(plainText(value.prefix, field, { max: 64 })) };
  return result;
}

function parseOAuth(value: JsonValue | undefined): OAuthDefinition {
  if (!isPlainObject(value)) fail('invalid_definition', 'http.oauth');
  onlyKeys(value, ['scopes', 'clientId', 'clientSecret', 'issuer', 'redirectUri'], 'http.oauth');
  const scopes = value.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.length > MAX_ITEMS || !scopes.every((scope: JsonValue): scope is string => isString(scope) && OAUTH_SCOPE.test(scope))) {
    fail('invalid_definition', 'http.oauth.scopes');
  }
  const result: MutableOAuthDefinition = { scopes: [...scopes] };
  if (value.clientId !== undefined) result.clientId = plainText(value.clientId, 'http.oauth.clientId', { max: 512 });
  if (value.issuer !== undefined) result.issuer = parseUrl(value.issuer, 'http.oauth.issuer');
  if (value.redirectUri !== undefined) result.redirectUri = parseRedirectUri(value.redirectUri, 'http.oauth.redirectUri');
  if (value.clientSecret !== undefined) {
    if (!isPlainObject(value.clientSecret)) fail('invalid_definition', 'http.oauth.clientSecret');
    onlyKeys(value.clientSecret, ['secret'], 'http.oauth.clientSecret');
    result.clientSecret = { secret: slotReference(value.clientSecret, 'secret', 'http.oauth.clientSecret') };
  }
  return result;
}

export function parseHttp(value: JsonValue | undefined): HttpDefinition {
  if (!isPlainObject(value)) fail('invalid_definition', 'http');
  onlyKeys(value, ['url', 'headers', 'oauth'], 'http');
  const headers = value.headers ?? {};
  if (!isPlainObject(headers) || Object.keys(headers).length > MAX_ITEMS) fail('invalid_definition', 'http.headers');
  const parsedHeaders: Record<string, HeaderValue> = {};
  for (const [name, item] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) fail('reserved_header', `http.headers.${name}`);
    if (Object.keys(parsedHeaders).some((existing) => existing.toLowerCase() === name.toLowerCase())) fail('invalid_definition', `http.headers.${name}`);
    parsedHeaders[name] = parseHeaderValue(item, `http.headers.${name}`);
  }
  const result = { url: parseUrl(value.url, 'http.url'), headers: parsedHeaders };
  if (value.oauth !== undefined) {
    if (Object.keys(parsedHeaders).some((name) => name.toLowerCase() === 'authorization')) fail('conflicting_authorization', 'http.headers.Authorization');
    return { ...result, oauth: parseOAuth(value.oauth) };
  }
  return result;
}
