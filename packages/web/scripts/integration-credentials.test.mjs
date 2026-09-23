import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIntegrationToken, constantTimeHashEqual, hashIntegrationToken } from '../server/lib/integration-control/auth.js';

const script = fileURLToPath(new URL('./integration-credentials.mjs', import.meta.url));

describe('offline integration credentials CLI', () => {
  let directory;
  let output;
  let policyFile;
  let results;
  let tokens;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'oc-credentials-'));
    output = join(directory, 'token');
    policyFile = join(directory, 'policy.json');
    results = [];
    tokens = [];
    vi.stubEnv('OPENCHAMBER_INTEGRATION_POLICY_FILE', policyFile);
  });
  afterEach(async () => {
    try {
      // Boolean assertions ensure even a failing assertion cannot print a token.
      for (const token of tokens) {
        for (const result of results) {
          expect(`${result.stdout}${result.stderr}`.includes(token)).toBe(false);
        }
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const run = (args) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    });
    results.push(result);
    return result;
  };
  const issueArgs = () => [
    '--policy', policyFile, '--output', output, '--id', 'fixture', '--domain', 'test',
    '--project', 'p1', '--action', 'projects.list', '--expires-at', '2099-01-01T00:00:00Z',
  ];
  const readToken = async () => {
    const token = (await readFile(output, 'utf8')).trim();
    tokens.push(token);
    return token;
  };

  it('issues a 0600 token, authenticates, refuses overwrite, then revokes atomically', async () => {
    expect(run(issueArgs()).status).toBe(0);
    const token = await readToken();
    expect(/^oc_integration_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect((await stat(policyFile)).mode & 0o777).toBe(0o640);
    const policyBytes = await readFile(policyFile, 'utf8');
    const policy = JSON.parse(policyBytes);
    expect(policyBytes.includes(token)).toBe(false);
    expect(constantTimeHashEqual(policy.credentials[0].tokenHash, hashIntegrationToken(token))).toBe(true);
    expect((await checkIntegrationToken(token)).success).toBe(true);
    expect(run(issueArgs()).status).toBe(1);
    expect(constantTimeHashEqual(hashIntegrationToken(await readToken()), hashIntegrationToken(token))).toBe(true);
    expect(await readFile(policyFile, 'utf8')).toBe(policyBytes);
    expect(run(['--policy', policyFile, '--id', 'fixture', '--revoke', '--force']).status).toBe(0);
    expect((await checkIntegrationToken(token)).error.code).toBe('UNAUTHORIZED');
    expect((await readdir(directory)).sort()).toEqual(['policy.json', 'token']);
  });

  it('rotates only with explicit force and invalidates the previous token', async () => {
    expect(run(issueArgs()).status).toBe(0);
    const oldToken = await readToken();
    const oldStat = await stat(policyFile);
    expect(run([...issueArgs(), '--force']).status).toBe(0);
    const newToken = await readToken();
    expect((await checkIntegrationToken(oldToken)).error.code).toBe('UNAUTHORIZED');
    expect((await checkIntegrationToken(newToken)).success).toBe(true);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const newStat = await stat(policyFile);
    expect(newStat.ino).not.toBe(oldStat.ino);
    expect([newStat.uid, newStat.gid]).toEqual([oldStat.uid, oldStat.gid]);
  });

  it('never overwrites an existing output when creating a new policy', async () => {
    await writeFile(output, 'fixture sentinel', { mode: 0o600 });
    expect(run(issueArgs()).status).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('fixture sentinel');
    expect(await readdir(directory)).toEqual(['token']);
  });

  it('rejects malformed policies even with force and leaves the secret untouched', async () => {
    expect(run(issueArgs()).status).toBe(0);
    const token = await readToken();
    await writeFile(policyFile, '{invalid');
    expect(run([...issueArgs(), '--force']).status).toBe(1);
    expect(constantTimeHashEqual(hashIntegrationToken(await readToken()), hashIntegrationToken(token))).toBe(true);
    expect(await readFile(policyFile, 'utf8')).toBe('{invalid');
    expect((await checkIntegrationToken(token)).error.code).toBe('POLICY_UNAVAILABLE');
  });

  it('rejects invalid or expired grants before publishing any output', async () => {
    for (const suffix of [
      ['--expires-at', '2000-01-01T00:00:00Z'], ['--expires-at', 'invalid'],
      ['--action', 'unsupported'], ['--domain', 'invalid/domain'],
    ]) expect(run([...issueArgs(), ...suffix]).status).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses symlink outputs and overlapping destinations even with force', async () => {
    const target = join(directory, 'sentinel');
    await writeFile(target, 'unchanged');
    await symlink(target, output);
    expect(run([...issueArgs(), '--force']).status).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('unchanged');
    expect(run([...issueArgs(), '--output', policyFile, '--force']).status).toBe(1);
  });

  it('sanitizes parser errors even if a generated token is supplied as an invalid option', async () => {
    expect(run(issueArgs()).status).toBe(0);
    const token = await readToken();
    expect(run([`--${token}`]).status).toBe(1);
    expect(run(['--policy', policyFile, '--id', 'fixture', '--revoke']).status).toBe(1);
    expect((await checkIntegrationToken(token)).success).toBe(true);
  });
});
