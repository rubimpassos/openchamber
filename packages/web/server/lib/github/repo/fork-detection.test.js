import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveRepoNetwork } from './fork-detection.js';

let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-detection-'));
  execFileSync('git', ['init', '-q', directory]);
  execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', 'https://github.com/me/app.git']);
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const octokitFor = (permissions) => ({
  rest: {
    repos: {
      get: async () => ({ data: {
        fork: true, permissions,
        parent: { owner: { login: 'team' }, name: 'app', html_url: 'https://github.com/team/app' },
      } }),
    },
  },
});

describe('fork network push access', () => {
  test.each([
    [{ push: true }, true],
    [{ push: false, pull: true }, false],
    [undefined, false],
  ])('marks the origin with viewerCanPush from permissions %j', async (permissions, viewerCanPush) => {
    const network = await resolveRepoNetwork(octokitFor(permissions), directory, 'origin', { strictErrors: true });
    expect(network?.[0]).toMatchObject({ owner: 'me', repo: 'app', source: 'origin', viewerCanPush });
    expect(network?.[1]).toMatchObject({ owner: 'team', repo: 'app', source: 'upstream' });
  });
});
