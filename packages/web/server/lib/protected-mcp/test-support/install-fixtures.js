import fs from 'node:fs/promises';
import path from 'node:path';
import { trustedFixtureDirectory } from './fixtures.js';

export const ENGINE = { uid: 2_000_000_001, gids: [2_000_000_001] };

/** Privileged operations are recorded over a disposable root and never run. */
export function recordingSystem(overrides = {}) {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    trustedOwners: [0, process.getuid()],
    isRoot: () => true,
    hasSystemd: async () => true,
    identity: async () => ENGINE,
    ensureGroup: async (name) => {
      calls.push(['ensureGroup', name]);
      return name === 'openchamber-mcp-clients' ? 990 : name === 'openchamber-mcp-admins' ? 992 : 991;
    },
    ensureUser: async (name) => {
      calls.push(['ensureUser', name]);
      return 991;
    },
    addToGroup: record('addToGroup'),
    removeFromGroup: record('removeFromGroup'),
    removeUser: record('removeUser'),
    removeGroup: record('removeGroup'),
    chown: async () => {},
    systemctl: record('systemctl'),
    createTmpfiles: record('createTmpfiles'),
    nodeVersion: async () => 'v24.21.0\n',
    connect: async () => ({ protocol: 1, enforcement: { status: 'protected' } }),
    sockets: [],
    ...overrides,
  };
}

export async function createHostRoot() {
  const scratch = await trustedFixtureDirectory();
  const root = path.join(scratch.directory, 'root');
  await fs.mkdir(path.join(root, 'usr/bin'), { recursive: true });
  await fs.symlink('/usr/bin/node', path.join(root, 'usr/bin/node'));
  return { root, scratch };
}
