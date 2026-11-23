import crypto from 'crypto';
import { isString } from '../shared/guards.js';

const HASH_SCHEME = 'scrypt';
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const normalizeUiPassword = (candidate: string): string => {
  if (!isString(candidate)) {
    return '';
  }
  return candidate.normalize().trim();
};

export const deriveUiPasswordKey = (normalizedPassword: string, salt: Buffer) => crypto.scryptSync(normalizedPassword, salt, KEY_LENGTH);

export const hashUiPassword = (password: string) => {
  const normalized = normalizeUiPassword(password);
  if (!normalized) {
    throw new Error('Cannot hash an empty UI password');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveUiPasswordKey(normalized, salt);
  return `${HASH_SCHEME}$${salt.toString('base64')}$${key.toString('base64')}`;
};

type UiPasswordHash = { readonly salt: Buffer; readonly key: Buffer };

export const parseUiPasswordHash = (value: string): UiPasswordHash | null => {
  if (!isString(value)) return null;
  const parts = value.trim().split('$');
  if (parts.length !== 3 || parts[0] !== HASH_SCHEME) return null;
  const [, saltB64 = '', keyB64 = ''] = parts;
  if (!BASE64_PATTERN.test(saltB64) || !BASE64_PATTERN.test(keyB64)) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const key = Buffer.from(keyB64, 'base64');
  if (salt.length === 0 || key.length !== KEY_LENGTH) return null;
  return { salt, key };
};

export const isUiPasswordHashSet = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
