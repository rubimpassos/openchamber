import { isNumber, isPlainObject, isString } from '../../shared/guards.js';
import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import type { OAuthTokens } from './oauth-authorization.js';

export type StoredOAuthTokens = Pick<OAuthTokens, 'accessToken'> & Partial<Omit<OAuthTokens, 'accessToken'>>;

export const oauthObject = (value: JsonValue | undefined): JsonObject | null => isPlainObject(value) ? value : null;

export const oauthGeneration = (value: JsonValue | undefined): number => {
  const record = oauthObject(value);
  return isNumber(record?.generation) ? record.generation : 0;
};

export const isStoredOAuthTokens = (value: JsonValue | undefined): value is StoredOAuthTokens => {
  const tokens = oauthObject(value);
  return tokens !== null && isString(tokens.accessToken)
    && (tokens.refreshToken === undefined || tokens.refreshToken === null || isString(tokens.refreshToken))
    && (tokens.expiresAt === undefined || tokens.expiresAt === null || isNumber(tokens.expiresAt))
    && (tokens.scope === undefined || tokens.scope === null || isString(tokens.scope));
};
