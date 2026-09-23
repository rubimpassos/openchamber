import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateIntegrationToken, checkIntegrationToken, constantTimeHashEqual, hashIntegrationToken } from './auth.js';
import { ERROR_DEFINITIONS } from './contract.js';

describe('integration authentication', () => {
  let directory;
  let file;
  let token;
  let policy;
  const denied = { success: false, error: { code: 'UNAUTHORIZED', ...ERROR_DEFINITIONS.UNAUTHORIZED } };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'oc-auth-'));
    file = join(directory, 'policy.json');
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', file);
    token = `oc_integration_${randomBytes(32).toString('base64url')}`;
    policy = { schemaVersion: 1, domainId: 'test', credentials: [{
      id: 'fixture', domain: 'test', tokenHash: hashIntegrationToken(token),
      projectIds: ['p1'], actions: ['projects.list'], expiresAt: '2099-01-01T00:00:00Z', enabled: true,
    }] };
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const save = async (file, policy) => writeFile(file, JSON.stringify(policy));

  it('authenticates a synthetic issued token then immediately respects removal', async () => {
    await save(file, policy);
    expect(await checkIntegrationToken(token)).toEqual({ success: true, data: policy.credentials[0] });
    policy.credentials = [];
    await save(file, policy);
    expect(await checkIntegrationToken(token)).toEqual(denied);
  });

  it.each(['expired', 'disabled'])('rejects an %s credential after a successful request', async (reason) => {
    await save(file, policy);
    expect((await checkIntegrationToken(token)).success).toBe(true);
    if (reason === 'expired') policy.credentials[0].expiresAt = '2000-01-01T00:00:00Z';
    else policy.credentials[0].enabled = false;
    await save(file, policy);
    expect(await checkIntegrationToken(token)).toEqual(denied);
  });

  it('rechecks expiry at authentication time, including the exact expiry instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    expect(authenticateIntegrationToken(token, policy)).toEqual(denied);
  });

  it('returns sanitized 503 after a good read followed by malformed JSON or missing file', async () => {
    await save(file, policy);
    expect((await checkIntegrationToken(token)).success).toBe(true);
    await writeFile(file, '{invalid private contents');
    const unavailable = { success: false, error: { code: 'POLICY_UNAVAILABLE', ...ERROR_DEFINITIONS.POLICY_UNAVAILABLE } };
    expect(await checkIntegrationToken(token)).toEqual(unavailable);
    expect(await checkIntegrationToken(null)).toEqual(unavailable);
    await rm(file);
    expect(await checkIntegrationToken(token)).toEqual(unavailable);
  });

  it('rejects foreign token types, malformed input and invalid policies without throwing', () => {
    for (const candidate of [null, {}, '', 'oc_integration_short', 'oc_client_test', 'cookie',
      `oc_integration_${randomBytes(32).toString('base64url')}`]) {
      expect(authenticateIntegrationToken(candidate, policy)).toEqual(denied);
    }
    expect(authenticateIntegrationToken(token, null)).toEqual(denied);
    expect(authenticateIntegrationToken(token, { ...policy, schemaVersion: 2 })).toEqual(denied);
  });

  it('compares only complete SHA-256 hashes and rejects malformed or unequal values', () => {
    const hash = hashIntegrationToken(token);
    expect(constantTimeHashEqual(hash, hash)).toBe(true);
    expect(constantTimeHashEqual(hash, hashIntegrationToken('different'))).toBe(false);
    for (const invalid of ['', null, {}, 'zz'.repeat(32), 'a'.repeat(62), `${hash}aa`]) {
      expect(constantTimeHashEqual(hash, invalid)).toBe(false);
    }
  });
});
