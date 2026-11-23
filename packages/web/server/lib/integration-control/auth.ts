import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ERROR_DEFINITIONS } from './contract.js';
import { isCredentialActive, loadIntegrationPolicy, validateIntegrationPolicy } from './policy.js';
import type { IntegrationCredential } from './policy.js';
import type { ContractResult } from './contract.js';

const tokenSchema = z.string().regex(/^oc_integration_[A-Za-z0-9_-]{43,1024}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const hashIntegrationToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Adapted from client-auth/remote-clients.js's private constantTimeEqual.
// That helper is not exported; importing its runtime would couple auth stores.
export const constantTimeHashEqual = (left: unknown, right: unknown) => {
  const parsedLeft = hashSchema.safeParse(left);
  const parsedRight = hashSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) return false;
  return timingSafeEqual(Buffer.from(parsedLeft.data, 'hex'), Buffer.from(parsedRight.data, 'hex'));
};

const unauthorized = () => ({
  success: false,
  error: { code: 'UNAUTHORIZED', ...ERROR_DEFINITIONS.UNAUTHORIZED },
} as const);

// Only consumes a request-local policy. No token/store writes, promotion or renewal.
export const authenticateIntegrationToken = (token: unknown, policy: unknown): ContractResult<IntegrationCredential> => {
  try {
    const validated = validateIntegrationPolicy(policy);
    const parsedToken = tokenSchema.safeParse(token);
    if (!validated.success || !parsedToken.success) return unauthorized();
    const hash = hashIntegrationToken(parsedToken.data);
    const credential = validated.data.credentials.find((entry) =>
      constantTimeHashEqual(entry.tokenHash, hash) && isCredentialActive(entry));
    return credential ? { success: true, data: credential } : unauthorized();
  } catch {
    return unauthorized();
  }
};

// Preferred request entrypoint: invalid policy takes precedence over bearer errors.
export const checkIntegrationToken = async (token: unknown) => {
  const policy = await loadIntegrationPolicy();
  return policy.success ? authenticateIntegrationToken(token, policy.data) : policy;
};
