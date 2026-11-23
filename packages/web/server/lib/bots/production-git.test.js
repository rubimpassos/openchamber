import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { advanceBotCheckout, botGit, createBotCheckoutGit } from './production-git.js';

let directory;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function repository() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-production-git-test-'));
  await botGit(directory, ['init', '--quiet', '--initial-branch=main']);
  await botGit(directory, ['config', 'user.name', 'Fixture']);
  await botGit(directory, ['config', 'user.email', 'fixture@example.test']);
  await botGit(directory, ['config', 'commit.gpgsign', 'false']);
  return directory;
}

test('returns Git output when stdin contains binary blob bytes', async () => {
  // Given
  const cwd = await repository();
  const bytes = Buffer.from([0, 255, 10, 65]);
  // When
  const object = (await botGit(cwd, ['hash-object', '-w', '--stdin'], bytes)).trim();
  // Then
  expect((await botGit(cwd, ['cat-file', '-s', object])).trim()).toBe('4');
});

test('reads repository boolean aliases when constructing checkout settings', async () => {
  // Given
  const cwd = await repository();
  await botGit(cwd, ['config', 'core.ignorecase', 'yes']);
  await botGit(cwd, ['config', 'core.precomposeunicode', 'no']);
  await botGit(cwd, ['config', 'core.longpaths', '1']);
  // When
  const checkout = await createBotCheckoutGit(cwd);
  // Then
  expect(checkout.settings).toEqual({ ignoreCase: true, precompose: false, longPaths: true });
});

test('materializes a clean result while leaving the owning branch at its previous commit', async () => {
  // Given
  const cwd = await repository();
  await fs.writeFile(path.join(cwd, 'old.txt'), 'old\n');
  await botGit(cwd, ['add', '.']);
  await botGit(cwd, ['commit', '--quiet', '-m', 'Base']);
  const fromSha = (await botGit(cwd, ['rev-parse', 'HEAD'])).trim();
  await fs.rename(path.join(cwd, 'old.txt'), path.join(cwd, 'new.txt'));
  await botGit(cwd, ['add', '-A']);
  await botGit(cwd, ['commit', '--quiet', '-m', 'Rename']);
  const resultSha = (await botGit(cwd, ['rev-parse', 'HEAD'])).trim();
  await botGit(cwd, ['checkout', '--quiet', '--detach', fromSha]);
  await botGit(cwd, ['update-ref', 'refs/heads/main', fromSha, resultSha]);
  await botGit(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // When
  await advanceBotCheckout({ directory: cwd, fromSha, resultSha });
  // Then
  expect(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).toBe('old\n');
  expect(await fs.readdir(cwd)).not.toContain('old.txt');
  expect((await botGit(cwd, ['rev-parse', 'HEAD'])).trim()).toBe(resultSha);
  expect((await botGit(cwd, ['rev-parse', 'refs/heads/main'])).trim()).toBe(fromSha);
  expect((await botGit(cwd, ['status', '--porcelain'])).trim()).toBe('');
});

test('reports the local Git failure contract when Git rejects an ordinary command', async () => {
  // Given
  const cwd = await repository();
  // When
  const result = botGit(cwd, ['rev-parse', '--verify', 'refs/heads/missing']);
  // Then
  await expect(result).rejects.toMatchObject({ code: 'BOT_GIT_LOCAL_FAILED' });
});
