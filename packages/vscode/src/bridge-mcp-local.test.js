import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({ workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) } }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-local-mcp-bridge-'));
const previous = { data: process.env.OPENCHAMBER_DATA_DIR, config: process.env.OPENCODE_CONFIG_DIR, explicit: process.env.OPENCODE_CONFIG };
process.env.OPENCHAMBER_DATA_DIR = path.join(root, 'private');
process.env.OPENCODE_CONFIG_DIR = path.join(root, 'user');
delete process.env.OPENCODE_CONFIG;
const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');
const { localMcpStore } = await import('./local-mcp-runtime.ts');
const { listMcpConfigs, getMcpConfig } = await import('./opencodeConfig.ts');
let project;
let mode;
const ctx = { manager: { getWorkingDirectory: () => project, getDebugInfo: () => ({ mode }) } };
const request = (payload) => handleConfigBridgeMessage({ id: 'mcp', type: 'api:config/mcp', payload }, ctx, {});
beforeEach(() => {
  project = fs.mkdtempSync(path.join(root, 'project-'));
  mode = 'managed';
});
afterAll(() => {
  for (const [key, value] of [['OPENCHAMBER_DATA_DIR', previous.data], ['OPENCODE_CONFIG_DIR', previous.config], ['OPENCODE_CONFIG', previous.explicit]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VS Code project-local MCP bridge', () => {
  test.each(['PATCH', 'DELETE'])('keeps %s on the captured local owner when another process removes it during lookup', async (method) => {
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    const snapshot = localMcpStore().read(project);
    fs.mkdirSync(path.join(project, '.opencode'));
    const configPath = path.join(project, '.opencode', 'opencode.json');
    const original = JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url: 'https://team.example/mcp' } } } });
    fs.writeFileSync(configPath, original);
    const readFile = fs.readFileSync;
    let removed = false;
    const read = spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const content = readFile(...args);
      // Another process commits its removal after this lookup obtained local data.
      if (!removed && args[0] === snapshot.path) {
        removed = true;
        fs.unlinkSync(snapshot.path);
      }
      return content;
    });
    try {
      await expect(request({ method, name: 'docs', body: { scope: 'local', url: 'https://private-updated.example/mcp' } }))
        .rejects.toMatchObject({ code: 'MCP_LOCAL_NOT_FOUND' });
    } finally {
      read.mockRestore();
    }
    expect(removed).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  test.each(['PATCH', 'DELETE'])('rejects stale local %s after another window removes the override', async (method) => {
    // Given a private editor whose entry disappeared above a shared definition.
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    fs.mkdirSync(path.join(project, '.opencode'));
    const configPath = path.join(project, '.opencode', 'opencode.json');
    const original = JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url: 'https://team.example/mcp' } } } });
    fs.writeFileSync(configPath, original);
    await localMcpStore().remove('docs', project);
    // When the stale editor sends its expected local owner.
    const result = request({ method, name: 'docs', body: { scope: 'local', url: 'https://private-updated.example/mcp' } });
    // Then the shared bytes survive and the caller receives a conflict.
    await expect(result).rejects.toMatchObject({ code: 'MCP_SCOPE_CONFLICT' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  for (const scope of ['user', 'project']) {
    test.each(['PATCH', 'DELETE'])(`rejects %s when the expected ${scope} owner is now local`, async (method) => {
      // Given a local override above the editor's expected owner.
      await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
      const snapshot = localMcpStore().read(project);
      const original = fs.readFileSync(snapshot.path, 'utf8');
      // When a stale editor submits a different expected owner.
      const result = request({ method, name: 'docs', body: { scope, disabled: true } });
      // Then every expected scope is enforced without modifying private data.
      await expect(result).rejects.toMatchObject({ code: 'MCP_SCOPE_CONFLICT' });
      expect(fs.readFileSync(snapshot.path, 'utf8')).toBe(original);
    });
  }

  test('returns no entry when constructor is only inherited from the prototype', () => {
    // Given a project with no configured MCP servers.
    // When looking up a valid name that is also an Object prototype property.
    const entry = getMcpConfig('constructor', project);
    // Then an inherited property cannot become a local server.
    expect(entry).toBeNull();
  });

  test('creates a private server named constructor when it is absent', async () => {
    // Given an empty private store and a valid server configuration.
    const body = { scope: 'local', type: 'remote', url: 'https://constructor.example/mcp' };
    // When creating a server whose name overlaps an inherited property.
    const result = await request({ method: 'POST', name: 'constructor', body });
    // Then the committed server is available under its own name.
    expect(result.success).toBe(true);
    expect(getMcpConfig('constructor', project)).toMatchObject({ name: 'constructor', scope: 'local', url: body.url });
  });

  test.each(['PATCH', 'DELETE'])('applies %s to the private constructor owner', async (method) => {
    // Given an actual local-owned entry named constructor.
    await localMcpStore().create('constructor', { type: 'remote', url: 'https://private.example/mcp' }, project);
    // When mutating the entry through the bridge.
    const result = await request({ method, name: 'constructor', body: { disabled: true } });
    // Then the mutation is committed to the effective local owner.
    expect(result.success).toBe(true);
    expect(getMcpConfig('constructor', project)).toEqual(method === 'DELETE' ? null : expect.objectContaining({ scope: 'local', disabled: true }));
  });

  test.each(['PATCH', 'DELETE'])('keeps the project constructor owner for %s when the private store is empty', async (method) => {
    // Given a project entry and no local entry with the same name.
    fs.mkdirSync(path.join(project, '.opencode'));
    fs.writeFileSync(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { servers: { constructor: { type: 'remote', url: 'https://team.example/mcp' } } } }));
    // When mutating the project-owned entry.
    const result = await request({ method, name: 'constructor', body: { disabled: true } });
    // Then an inherited local property cannot redirect the mutation.
    expect(result.success).toBe(true);
    expect(getMcpConfig('constructor', project)).toEqual(method === 'DELETE' ? null : expect.objectContaining({ scope: 'project', disabled: true }));
    expect(localMcpStore().read(project).servers).toEqual({});
  });

  test.each(['managed', 'external'])('reports manager capability in %s mode', async (runtimeMode) => {
    // Given the authoritative manager mode.
    mode = runtimeMode;
    // When requesting the OpenChamber capability.
    const result = await handleConfigBridgeMessage({ id: 'caps', type: 'api:config/mcp-capabilities' }, ctx, {});
    // Then external servers cannot advertise private project-local support.
    expect(result.data).toEqual({ projectLocal: runtimeMode === 'managed' });
  });

  test('persists a private local entry before the create bridge resolves', async () => {
    // Given a managed runtime and the shared collection POST format.
    const body = { name: 'docs', scope: 'local', type: 'remote', url: 'https://local.example/mcp' };
    // When the bridge creates the server.
    const result = await request({ method: 'POST', body });
    // Then its committed entry is visible outside the repository.
    expect(result.success).toBe(true);
    expect(getMcpConfig('docs', project)).toMatchObject({ scope: 'local', url: body.url });
    expect(result.data.path.startsWith(path.join(root, 'private') + path.sep)).toBe(true);
    expect(fs.readdirSync(project)).toEqual([]);
  });

  test('updates the effective local owner while preserving a shadowed project entry', async () => {
    // Given two layers that define the same server.
    const configDir = path.join(project, '.opencode');
    fs.mkdirSync(configDir);
    const configPath = path.join(configDir, 'opencode.json');
    const original = JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url: 'https://team.example/mcp' } } } });
    fs.writeFileSync(configPath, original);
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    // When updating the effective entry.
    const result = await request({ method: 'PATCH', name: 'docs', body: { disabled: true } });
    // Then only the local owner changes and the list contains one effective entry.
    expect(result.success).toBe(true);
    expect(listMcpConfigs(project)).toEqual([expect.objectContaining({ name: 'docs', scope: 'local', disabled: true })]);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  test('deletes a local entry before the bridge reports success', async () => {
    // Given a persisted local server.
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    // When deleting through the bridge.
    const result = await request({ method: 'DELETE', name: 'docs' });
    // Then authoritative reads no longer contain it.
    expect(result.success).toBe(true);
    expect(getMcpConfig('docs', project)).toBeNull();
  });

  const editorCases = [
    ['stdio', { type: 'local', command: ['test-mcp'] }, { environment: { MODE: 'test' }, cwd: '/test' }],
    ['remote', { type: 'remote', url: 'https://private.example/mcp' }, { headers: { 'X-Test': 'fixture' }, oauth: { client_id: 'fixture' } }],
  ];

  test.each(editorCases)('accepts editor null defaults when creating a private %s server', async (_label, required, optional) => {
    // Given the editor's null defaults for optional overrides.
    const removals = Object.fromEntries(Object.keys(optional).map((key) => [key, null]));
    const body = { ...required, ...removals, scope: 'local', timeout: null, codemode: null, protocol: null };
    // When saving through the bridge.
    const result = await request({ method: 'POST', name: 'docs', body });
    // Then the persisted entry contains only the supplied required fields.
    expect(result.success).toBe(true);
    expect(localMcpStore().read(project).servers.docs).toEqual(required);
  });

  test.each(editorCases)('removes optional overrides when the private %s editor sends null', async (_label, required, optional) => {
    // Given persisted overrides that differ from the editor's removal markers.
    await localMcpStore().create('docs', { ...required, ...optional, disabled: true, timeout: { catalog: 1000 }, codemode: true, protocol: 'auto' }, project);
    const removals = Object.fromEntries(Object.keys(optional).map((key) => [key, null]));
    // When the editor clears optional values through the bridge.
    const result = await request({ method: 'PATCH', name: 'docs', body: { ...removals, scope: 'local', timeout: null, codemode: null, protocol: null } });
    // Then removals reach the core while omitted fields remain unchanged.
    expect(result.success).toBe(true);
    expect(localMcpStore().read(project).servers.docs).toEqual({ ...required, disabled: true });
  });

  test.each(['POST', 'PATCH', 'DELETE'])('rejects local %s against external OpenCode without writing', async (method) => {
    // Given a local-owned entry and an external runtime.
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    const snapshot = localMcpStore().read(project);
    const original = fs.readFileSync(snapshot.path, 'utf8');
    mode = 'external';
    // When attempting a local mutation, including bodyless owner-based delete.
    const result = await request({ method, name: method === 'POST' ? 'other' : 'docs', body: method === 'POST' ? { scope: 'local', type: 'remote', url: 'https://other.example/mcp' } : undefined });
    // Then the bridge reports unsupported behavior and leaves the file intact.
    expect(result.success).toBe(false);
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe(original);
  });

  test('rejects duplicate names from the project config before a local write', async () => {
    // Given a server already defined by the project.
    fs.mkdirSync(path.join(project, '.opencode'));
    fs.writeFileSync(path.join(project, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url: 'https://team.example/mcp' } } } }));
    // When creating another effective entry with the same name, then it fails.
    await expect(request({ method: 'POST', name: 'docs', body: { scope: 'local', type: 'remote', url: 'https://private.example/mcp' } })).rejects.toThrow(/already exists/);
    expect(localMcpStore().read(project).servers).toEqual({});
  });

  test('propagates malformed private files without reporting an empty list', async () => {
    // Given malformed persisted local data.
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    const snapshot = localMcpStore().read(project);
    fs.writeFileSync(snapshot.path, '{ broken');
    // When listing, then parse failure reaches the bridge caller.
    await expect(request({ method: 'GET' })).rejects.toThrow();
  });

  test.each(['POST', 'PATCH', 'DELETE'])('reports a malformed private file as failed %s without rewriting it', async (method) => {
    // Given malformed private data for an existing project.
    await localMcpStore().create('docs', { type: 'remote', url: 'https://private.example/mcp' }, project);
    const snapshot = localMcpStore().read(project);
    const malformed = '{ broken';
    fs.writeFileSync(snapshot.path, malformed);
    // When mutating, then the operation rejects and preserves the damaged file.
    await expect(request({ method, name: 'docs', body: { scope: 'local', type: 'remote', url: 'https://new.example/mcp' } })).rejects.toThrow();
    expect(fs.readFileSync(snapshot.path, 'utf8')).toBe(malformed);
  });

  test('preserves malformed project config when creating a private server', async () => {
    // Given an unreadable effective layer, whose names cannot be checked.
    fs.mkdirSync(path.join(project, '.opencode'));
    const configPath = path.join(project, '.opencode', 'opencode.json');
    const malformed = '{ "mcp":';
    fs.writeFileSync(configPath, malformed);
    // When creating locally, then uncertainty cannot become a successful save.
    await expect(request({ method: 'POST', name: 'docs', body: { scope: 'local', type: 'remote', url: 'https://private.example/mcp' } })).rejects.toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(malformed);
    expect(localMcpStore().read(project).servers).toEqual({});
  });
});
