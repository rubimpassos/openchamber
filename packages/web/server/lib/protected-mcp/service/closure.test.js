import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitServiceFixture } from '../test-support/emitted-service.js';
import { trustedFixtureDirectory } from '../test-support/fixtures.js';
import { copyTree, sourceFiles } from './install-files.js';

const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
let scratch;
let installed;
let files;
beforeAll(async () => {
  scratch = await trustedFixtureDirectory();
  const source = path.join(scratch.directory, 'emitted');
  installed = path.join(scratch.directory, 'installed');
  await emitServiceFixture(source);
  files = await sourceFiles(source);
  await copyTree({ system: { chown: async () => {} }, source, files, target: installed, version: 'test' });
});
afterAll(async () => { await scratch?.remove(); });

describe('installed service import closure', () => {
  it('copies every transitive import using only Node built-ins and the approved guards', () => {
    // Given the installer's emitted, copied file set, including both shared guards.
    const allowed = new Set(files.map((file) => path.join(installed, file)));
    const outside = [];
    // When every installed module's imports are resolved, shared guards included.
    for (const file of allowed) {
      for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(specifierPattern)) {
        if (specifier.startsWith('node:')) continue;
        const target = path.resolve(path.dirname(file), specifier);
        if (!specifier.startsWith('.') || !allowed.has(target) || !fs.existsSync(target)) outside.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    // Then the installed tree has no dependency on the engine or node_modules.
    expect(outside).toEqual([]);
    expect(files.filter((file) => !file.startsWith('lib/protected-mcp/service/'))).toEqual([
      path.join('lib', 'shared', 'guards.js'),
      path.join('lib', 'shared', 'object-guards.js'),
    ]);
  });

  it.each([['main.js', [], 64], ['relay.js', ['--help'], 0], ['install.js', ['--help'], 0]])(
    'loads the installed %s with plain Node and no TypeScript loader', (entry, args, status) => {
      // Given the standalone installed tree, without node_modules.
      const command = path.join(installed, 'lib/protected-mcp/service', entry);
      // When Node runs a non-mutating entry path.
      const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } });
      // Then all imports load and the entry reports its ordinary usage outcome.
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
    },
  );
});
