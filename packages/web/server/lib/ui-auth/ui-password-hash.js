import crypto from 'crypto';

// Pre-hashed UI password: `scrypt$<salt_base64>$<hash_base64>`, scrypt with
// Node's scryptSync defaults (N=16384, r=8, p=1) and a 64-byte key over the
// normalized password. Lets OPENCHAMBER_UI_PASSWORD_HASH replace the plaintext
// OPENCHAMBER_UI_PASSWORD so the password never has to exist on the server.
const HASH_SCHEME = 'scrypt';
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const normalizeUiPassword = (candidate) => {
  if (typeof candidate !== 'string') {
    return '';
  }
  return candidate.normalize().trim();
};

export const deriveUiPasswordKey = (normalizedPassword, salt) => crypto.scryptSync(normalizedPassword, salt, KEY_LENGTH);

export const hashUiPassword = (password) => {
  const normalized = normalizeUiPassword(password);
  if (!normalized) {
    throw new Error('Cannot hash an empty UI password');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveUiPasswordKey(normalized, salt);
  return `${HASH_SCHEME}$${salt.toString('base64')}$${key.toString('base64')}`;
};

export const parseUiPasswordHash = (value) => {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('$');
  if (parts.length !== 3 || parts[0] !== HASH_SCHEME) return null;
  const [, saltB64, keyB64] = parts;
  if (!BASE64_PATTERN.test(saltB64) || !BASE64_PATTERN.test(keyB64)) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const key = Buffer.from(keyB64, 'base64');
  if (salt.length === 0 || key.length !== KEY_LENGTH) return null;
  return { salt, key };
};

export const isUiPasswordHashSet = (value) => typeof value === 'string' && value.trim().length > 0;
