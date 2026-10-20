import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMcpStore } from './mcp-local.js';
import { writeLocalMcpFile } from './mcp-local-files.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-local-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'private');
  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  return { root, project, dataDir, store: createLocalMcpStore({ dataDir }) };
}
const local = { type: 'local', command: ['node', 'server.js'] };

describe('project-local MCP store', () => {
  it('shares identity with subdirectories and linked worktrees when their common Git directory matches', async () => {
    // Given a checkout, a subdirectory and a linked worktree without invoking Git.
    const { root, project, store } = await fixture();
    const linked = path.join(root, 'linked');
    const metadata = path.join(project, '.git', 'worktrees', 'linked');
    const child = path.join(project, 'src');
    await Promise.all([fs.mkdir(linked), fs.mkdir(metadata, { recursive: true }), fs.mkdir(child)]);
    await fs.writeFile(path.join(linked, '.git'), `gitdir: ${metadata}\n`);
    await fs.writeFile(path.join(metadata, 'commondir'), '../..\n');
    // When writing through the linked worktree.
    await store.create('tools', local, linked);
    // Then all directories resolve the same snapshot.
    expect(store.read(child)).toEqual(store.read(project));
    expect(store.read(linked)).toEqual(store.read(project));
  });

  it('isolates independent clones and exact non-Git directories', async () => {
    // Given a second clone and nested non-Git directories.
    const { root, project, store } = await fixture();
    const clone = path.join(root, 'clone');
    const plain = path.join(root, 'plain');
    const nested = path.join(plain, 'nested');
    await fs.mkdir(path.join(clone, '.git'), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    // When saving a server in the original clone and one non-Git directory.
    await store.create('tools', local, project);
    await store.create('tools', local, plain);
    // Then no unrelated directory receives either entry.
    expect(store.read(clone).servers).toEqual({});
    expect(store.read(nested).servers).toEqual({});
    expect(new Set([project, clone, plain, nested].map((directory) => store.read(directory).identity)).size).toBe(4);
  });

  it('canonicalizes directory symlinks when resolving identity', async () => {
    const { root, project, store } = await fixture();
    const alias = path.join(root, 'alias');
    await fs.symlink(project, alias, 'dir');
    const snapshot = store.read(alias);
    expect(snapshot.identity).toBe(store.read(project).identity);
  });

  it('round-trips all v2 fields and retained extension fields when updating an entry', async () => {
    // Given a remote entry carrying fields outside the Settings editor.
    const { project, store } = await fixture();
    const config = {
      type: 'remote', url: 'https://mcp.invalid', headers: { Authorization: '{env:TOKEN}' },
      disabled: false, codemode: true, protocol: '2026-07-28',
      timeout: { startup: 100, catalog: 200, execution: 300 },
      oauth: { client_id: 'client', client_secret: '{file:secret}', scope: 'tools', callback_port: 4321,
        redirect_uri: 'http://localhost/callback', auth_server_metadata_url: 'https://auth.invalid', extension: true },
      extension: { nested: ['retained'] },
    };
    await store.create('tools', config, project);
    // When the editor changes only the enabled state.
    await store.update('tools', { disabled: true }, project);
    // Then every unedited field survives exactly.
    expect(store.read(project).servers.tools).toEqual({ ...config, disabled: true });
  });

  it('keeps files private and removes only its entry when deleting a server', async () => {
    const { project, store } = await fixture();
    await store.create('tools', { ...local, cwd: './src', environment: { TOKEN: 'secret' } }, project);
    await store.create('other', local, project);
    const { path: filename } = await store.remove('tools', project);
    expect(store.read(project).servers).toEqual({ other: local });
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(filename))).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(path.dirname(filename))).toEqual([path.basename(filename)]);
    expect(await fs.readdir(project)).toEqual(['.git']);
  });

  it.each([
    '{ broken secret',
    JSON.stringify({ version: 2, identity: 'wrong', servers: {} }),
    JSON.stringify({ version: 1, identity: 'wrong', servers: {} }),
    JSON.stringify({ version: 1, servers: [] }),
  ])('refuses malformed persisted state without overwriting it', async (content) => {
    const { project, store } = await fixture();
    const { path: filename } = await store.create('tools', local, project);
    await fs.writeFile(filename, content);
    await expect(store.update('tools', { disabled: true }, project)).rejects.toMatchObject({ code: 'MCP_LOCAL_INVALID' });
    expect(await fs.readFile(filename, 'utf8')).toBe(content);
  });

  it('distinguishes missing from empty and unreadable state', async () => {
    const { project, store } = await fixture();
    const initial = store.read(project);
    await store.create('tools', local, project);
    await store.remove('tools', project);
    const empty = store.read(project);
    await fs.rm(initial.path);
    await fs.mkdir(initial.path);
    expect(initial).toMatchObject({ exists: false, servers: {} });
    expect(empty).toMatchObject({ exists: true, servers: {} });
    expect(() => store.read(project)).toThrowError(expect.objectContaining({ code: 'MCP_LOCAL_UNREADABLE' }));
  });

  it('rejects invalid entries and nonexistent or duplicate mutations', async () => {
    const { project, store } = await fixture();
    await store.create('tools', local, project);
    await expect(store.create('tools', local, project)).rejects.toMatchObject({ code: 'MCP_LOCAL_EXISTS' });
    await expect(store.create('bad', { type: 'local', command: [] }, project)).rejects.toMatchObject({ code: 'MCP_LOCAL_INVALID' });
    await expect(store.update('absent', {}, project)).rejects.toMatchObject({ code: 'MCP_LOCAL_NOT_FOUND' });
    await expect(store.remove('absent', project)).rejects.toMatchObject({ code: 'MCP_LOCAL_NOT_FOUND' });
  });

  it('serializes independent store instances when read-modify-write operations overlap', async () => {
    const { dataDir, project, store } = await fixture();
    const other = createLocalMcpStore({ dataDir });
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? store : other).create(`server-${index}`, local, project)));
    expect(Object.keys(store.read(project).servers)).toHaveLength(12);
  });

  it('cleans temporary files when atomic publication fails', async () => {
    const { project, store } = await fixture();
    const { path: filename } = store.read(project);
    await fs.mkdir(filename, { recursive: true });
    // A directory occupying the final filename refuses atomic rename.
    await expect(writeLocalMcpFile(filename, '{}')).rejects.toThrow();
    expect(await fs.readdir(path.dirname(filename))).toEqual([path.basename(filename)]);
  });
});
