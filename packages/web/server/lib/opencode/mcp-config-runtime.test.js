import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerConfigEntityRoutes } from './config-entity-routes.js';

let root;
let createMcpConfigRuntime;
let sequence = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-local-mcp-routes-'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
  vi.stubEnv('OPENCODE_CONFIG', '');
  ({ createMcpConfigRuntime } = await import('./mcp-config-runtime.js'));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const harness = async ({ supported = true } = {}) => {
  const directory = path.join(root, `project-${++sequence}`);
  const otherDirectory = path.join(root, `other-${sequence}`);
  await Promise.all([directory, otherDirectory].map((dir) => fs.mkdir(path.join(dir, '.git'), { recursive: true })));
  const runtime = createMcpConfigRuntime({ dataDir: path.join(root, `data-${sequence}`), isLocalScopeSupported: () => supported });
  const app = express();
  app.use(express.json());
  registerConfigEntityRoutes(app, {
    ...runtime,
    resolveOptionalProjectDirectory: async (req) => ({ directory: req.query.directory || directory }),
  });
  return { app, runtime, directory, otherDirectory };
};

const server = { type: 'remote', url: 'https://example.invalid/mcp', disabled: true };

describe('personal project MCP routes', () => {
  for (const method of ['patch', 'delete']) {
    it(`refuses a stale local ${method} without changing a newly exposed shared definition`, async () => {
      const { app, runtime, directory } = await harness();
      await runtime.createMcpConfig('personal', server, directory, 'local');
      await fs.mkdir(path.join(directory, '.opencode'));
      const configPath = path.join(directory, '.opencode', 'opencode.json');
      const shared = JSON.stringify({ mcp: { servers: { personal: { ...server, url: 'https://shared.invalid/mcp' } } } });
      await fs.writeFile(configPath, shared);
      await runtime.deleteMcpConfig('personal', directory, 'local');

      const response = await request(app)[method]('/api/config/mcp/personal')
        .send({ scope: 'local', url: 'https://private.invalid/mcp', headers: { Authorization: 'private-fixture' } });

      expect(response.status).toBe(409);
      expect(await fs.readFile(configPath, 'utf8')).toBe(shared);
    });
  }

  it('persists a project-local server without touching repository configuration or another project', async () => {
    // Given a repository with a shared MCP file.
    const { app, directory, otherDirectory } = await harness();
    const configPath = path.join(directory, 'opencode.json');
    const shared = '{ "mcp": { "servers": { "shared": { "type": "local", "command": ["shared"] } } } }\n';
    await fs.writeFile(configPath, shared);

    // When a personal server is created through the ordinary route.
    const response = await request(app).post('/api/config/mcp/personal').send({ ...server, scope: 'local' });

    // Then only this project's host-owned entry is added.
    expect(response.status).toBe(200);
    expect(response.body.path.startsWith(directory + path.sep)).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(shared);
    await expect(fs.stat(path.join(directory, '.opencode'))).rejects.toMatchObject({ code: 'ENOENT' });
    const own = await request(app).get('/api/config/mcp');
    expect(own.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'personal', scope: 'local' })]));
    const other = await request(app).get('/api/config/mcp').query({ directory: otherDirectory });
    expect(other.body.some((entry) => entry.name === 'personal')).toBe(false);
  });

  it('edits the personal owner while preserving a same-named definition added by Git', async () => {
    // Given a personal entry and a later shared definition with the same name.
    const { app, runtime, directory } = await harness();
    await runtime.createMcpConfig('personal', server, directory, 'local');
    const configDir = path.join(directory, '.opencode');
    await fs.mkdir(configDir);
    const configPath = path.join(configDir, 'opencode.json');
    const shared = JSON.stringify({ mcp: { servers: { personal: { ...server, url: 'https://shared.invalid/mcp' } } } });
    await fs.writeFile(configPath, shared);

    // When the existing editor patches the effective entry.
    const response = await request(app).patch('/api/config/mcp/personal').send({ url: 'https://personal.invalid/mcp' });

    // Then the local definition changes and the shared file stays byte-identical.
    expect(response.status).toBe(200);
    expect((await request(app).get('/api/config/mcp/personal')).body).toMatchObject({ scope: 'local', url: 'https://personal.invalid/mcp' });
    expect(await fs.readFile(configPath, 'utf8')).toBe(shared);
  });

  it('reveals the current shared definition when a personal entry is deleted', async () => {
    // Given a personal entry shadowing a new shared definition.
    const { app, runtime, directory } = await harness();
    await runtime.createMcpConfig('personal', server, directory, 'local');
    await fs.mkdir(path.join(directory, '.opencode'));
    await fs.writeFile(path.join(directory, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { servers: { personal: { ...server, url: 'https://shared.invalid/mcp' } } } }));

    // When the personal entry is removed.
    const response = await request(app).delete('/api/config/mcp/personal');

    // Then the shared owner remains available with its current configuration.
    expect(response.status).toBe(200);
    expect((await request(app).get('/api/config/mcp/personal')).body).toMatchObject({ scope: 'project', url: 'https://shared.invalid/mcp' });
  });

  it('refuses personal writes before creating files on an external runtime', async () => {
    // Given an externally managed OpenCode connection.
    const { app } = await harness({ supported: false });

    // When the user tries to create a personal entry.
    const response = await request(app).post('/api/config/mcp/personal').send({ ...server, scope: 'local' });

    // Then the capability and mutation both explicitly report unsupported behavior.
    expect((await request(app).get('/api/config/mcp-capabilities')).body).toEqual({ projectLocal: false });
    expect(response.status).toBe(501);
    expect((await request(app).get('/api/config/mcp')).body).toEqual([]);
  });

  it('rejects an invalid scope rather than creating a global entry', async () => {
    const { app } = await harness();
    const response = await request(app).post('/api/config/mcp/personal').send({ ...server, scope: 'invalid' });
    expect(response.status).toBe(400);
    expect((await request(app).get('/api/config/mcp')).body).toEqual([]);
  });

  it('requires an explicit directory for personal scope', async () => {
    const { runtime } = await harness();
    await expect(runtime.createMcpConfig('personal', server, undefined, 'local')).rejects.toMatchObject({ status: 400 });
  });

  it('preserves repository-backed creation for shared project scope', async () => {
    // Given a project without an OpenCode config file.
    const { app, directory } = await harness();

    // When the existing project scope is selected.
    const response = await request(app).post('/api/config/mcp/shared').send({ ...server, scope: 'project' });

    // Then the entry still goes to the project's ordinary OpenCode config.
    expect(response.status).toBe(200);
    const saved = JSON.parse(await fs.readFile(path.join(directory, '.opencode', 'opencode.json'), 'utf8'));
    expect(saved.mcp.servers.shared).toEqual(server);
    expect((await request(app).get('/api/config/mcp/shared')).body.scope).toBe('project');
  });

  it('accepts the editor default values when creating a personal entry', async () => {
    // Given the same null removal markers sent by the MCP form.
    const { app } = await harness();
    const body = { ...server, scope: 'local', timeout: null, codemode: null, protocol: null, oauth: null };

    // When the form creates its personal entry.
    const response = await request(app).post('/api/config/mcp/personal').send(body);

    // Then defaults stay omitted from the stored OpenCode configuration.
    expect(response.status).toBe(200);
    const saved = (await request(app).get('/api/config/mcp/personal')).body;
    for (const key of ['timeout', 'codemode', 'protocol', 'oauth']) expect(saved).not.toHaveProperty(key);
  });

  it('removes an optional field when the personal editor restores its default', async () => {
    // Given an explicit Code Mode override.
    const { app, runtime, directory } = await harness();
    await runtime.createMcpConfig('personal', { ...server, codemode: true }, directory, 'local');

    // When the user selects the inherited default.
    const response = await request(app).patch('/api/config/mcp/personal').send({ codemode: null });

    // Then the override is absent rather than retained or stored as null.
    expect(response.status).toBe(200);
    expect((await request(app).get('/api/config/mcp/personal')).body).not.toHaveProperty('codemode');
  });
});
