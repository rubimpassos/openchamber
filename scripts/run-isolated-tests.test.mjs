import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-isolated-tests.mjs', import.meta.url));

test('one worker runs every file without overlapping their processes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'isolated-workers-'));
  try {
    const fixtures = path.join(root, 'fixtures');
    mkdirSync(fixtures);
    const lock = path.join(root, 'active');
    const source = `import { test } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
test('owns its process window', async () => {
  mkdirSync(${JSON.stringify(lock)});
  await new Promise(resolve => setTimeout(resolve, 50));
  rmSync(${JSON.stringify(lock)}, { recursive: true });
});`;
    for (const name of ['one', 'two']) writeFileSync(path.join(fixtures, `${name}.test.mjs`), source);
    const result = spawnSync(process.execPath, [runner, fixtures], {
      env: { ...process.env, OPENCHAMBER_TEST_WORKERS: '1' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\/2 test files passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid worker limits fail before starting tests', () => {
  for (const workers of ['0', '5', '1.5', 'invalid']) {
    const result = spawnSync(process.execPath, [runner, '.'], {
      env: { ...process.env, OPENCHAMBER_TEST_WORKERS: workers }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENCHAMBER_TEST_WORKERS must be an integer from 1 to 4/);
    assert.equal(result.stdout, '');
  }
});
