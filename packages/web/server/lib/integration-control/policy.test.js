import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_DEFINITIONS } from './contract.js';
import { loadIntegrationPolicy, validateIntegrationPolicy } from './policy.js';

const credential = () => ({
  id: 'fixture', domain: 'test-domain', tokenHash: 'a'.repeat(64),
  projectIds: ['project-1'], actions: ['projects.list'],
  expiresAt: '2099-01-01T00:00:00Z', enabled: true,
});
const policy = () => ({ schemaVersion: 1, domainId: 'test-domain', credentials: [credential()] });
const unavailable = {
  success: false, error: { code: 'POLICY_UNAVAILABLE', ...ERROR_DEFINITIONS.POLICY_UNAVAILABLE },
};

describe('integration policy', () => {
  let directory;
  let file;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'oc-policy-'));
    file = join(directory, 'policy.json');
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', file);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the full document every call, without last-known-good fallback', async () => {
    await writeFile(file, JSON.stringify(policy()));
    expect((await loadIntegrationPolicy()).data.credentials).toHaveLength(1);
    await writeFile(file, '{private invalid contents');
    expect(await loadIntegrationPolicy()).toEqual(unavailable);
    await writeFile(file, JSON.stringify({ ...policy(), credentials: [] }));
    expect((await loadIntegrationPolicy()).data.credentials).toEqual([]);
    await rm(file);
    expect(await loadIntegrationPolicy()).toEqual(unavailable);
  });

  it('denies missing, unconfigured and unreadable policy paths without disclosing them', async () => {
    expect(await loadIntegrationPolicy()).toEqual(unavailable);
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', directory);
    expect(await loadIntegrationPolicy()).toEqual(unavailable);
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', undefined);
    expect(await loadIntegrationPolicy()).toEqual(unavailable);
  });

  it('excludes disabled and expired entries without rejecting an otherwise valid policy', async () => {
    const value = policy();
    value.credentials.push({ ...credential(), id: 'disabled', enabled: false });
    value.credentials.push({ ...credential(), id: 'expired', expiresAt: '2000-01-01T00:00:00Z' });
    await writeFile(file, JSON.stringify(value));
    expect((await loadIntegrationPolicy()).data.credentials.map((entry) => entry.id)).toEqual(['fixture']);
    expect(validateIntegrationPolicy(value).data.credentials).toHaveLength(3);
  });

  it.each([
    { expiresAt: undefined }, { expiresAt: null }, { expiresAt: 'tomorrow' },
    { expiresAt: '2099-02-30T00:00:00Z' }, { enabled: 'true' }, { enabled: undefined },
    { tokenHash: 'xyz' }, { tokenHash: 'a'.repeat(63) }, { domain: 'other' },
    { projectIds: ['*'] }, { projectIds: ['p', 'p'] }, { actions: ['unknown'] },
    { actions: ['projects.list', 'projects.list'] }, { token: 'never-store-plaintext' },
  ])('rejects the entire policy on invalid record %#', (change) => {
    const value = policy();
    value.credentials.push({ ...credential(), id: 'bad-record', enabled: false, ...change });
    expect(validateIntegrationPolicy(value)).toEqual(unavailable);
  });

  it('rejects duplicate IDs, unexpected fields, wrong versions and non-objects', () => {
    for (const value of [
      null, [], {}, { ...policy(), schemaVersion: 2 }, { ...policy(), unexpected: true },
      { ...policy(), credentials: [credential(), credential()] },
    ]) expect(validateIntegrationPolicy(value)).toEqual(unavailable);
  });
});
