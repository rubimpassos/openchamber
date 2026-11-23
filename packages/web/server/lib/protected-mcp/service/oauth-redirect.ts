import { isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import type { JsonValue } from '../../shared/json-values.js';

export function parseRedirectUri(value: JsonValue | undefined, field: string | null = null): string {
  if (isString(value) && value.length <= 2048) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash) return url.href;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  throw new ProtectedMcpError('invalid_redirect_uri', { message: field ? `invalid_redirect_uri: ${field}` : 'invalid_redirect_uri' });
}
