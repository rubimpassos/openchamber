import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGatekeeperChannel } from './gatekeeper-channel.js';

describe('installed gatekeeper profile', () => {
  it.each(['general', 'pr-fix-loop-approval'])('reconstructs immutable %s policy using only Node builtins', async (purpose) => {
    // Given a host channel delivering its program into a directory without dependencies.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-profile-'));
    const installed = path.join(directory, 'gatekeeper.cjs');
    const channel = createGatekeeperChannel({ exec: async (_id, _argv, { stdin }) => {
      fs.writeFileSync(installed, stdin);
      return { code: 0, stdout: '', stderr: '' };
    } });
    const probe = `
      const { isBuiltin } = require('node:module');
      const Module = require('node:module');
      const original = Module._load;
      const file = process.argv[1];
      Module._load = function (id, ...args) {
        if (id !== file && !isBuiltin(id)) throw new Error('Non-stdlib dependency: ' + id);
        return original.call(this, id, ...args);
      };
      const rules = require(file);
      rules.spacePurpose = ${JSON.stringify(purpose === 'general' ? 'pr-fix-loop-approval' : 'general')};
      process.stdout.write(JSON.stringify({
        open: rules.setNetwork({ mode: 'open', domains: [] }),
        empty: rules.setNetwork({ mode: 'allowlist', domains: [] }),
        domain: rules.addGrant({ id: 'domain', upstream: 'https://api.github.com' }),
        model: rules.addGrant({ id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: 'disposable', model: { providerID: 'openai', modelID: 'gpt-4.1' } })
      }));
    `;
    try {
      // When create and restart each reconstruct the module from the host-selected purpose.
      for (const start of ['create', 'restart']) {
        await channel.writeProgram('a1b2c3d4e5f6', { bindAddress: '127.0.0.1', purpose });
        const run = spawnSync(process.execPath, ['-e', probe, installed], { cwd: directory, encoding: 'utf8' });
        // Then later module-field edits cannot change the captured profile or its grants.
        expect({ start, status: run.status, stderr: run.stderr }).toEqual({ start, status: 0, stderr: '' });
        const result = JSON.parse(run.stdout);
        expect(result.empty).toBeNull();
        expect(result.model).toBeNull();
        if (purpose === 'general') {
          expect(result.open).toBeNull();
          expect(result.domain).toBeNull();
        } else {
          expect(result.open).not.toBeNull();
          expect(result.domain).not.toBeNull();
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
