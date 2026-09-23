// Shared by Vitest and the adjacent Hermes protocol test. Only OpenCode is a
// local HTTP fixture; authorization, lifecycle, control and wire routes are real.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { registerIntegrationControlRoutes } from './routes.js';
import { hashIntegrationToken } from './auth.js';
import { ACTIONS } from './contract.js';

export const createNativeFailureFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-native-failure-'));
  const policyPath = path.join(root, 'policy.json');
  const previous = process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
  process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = policyPath;
  const token = `oc_integration_${'synthetic_'.repeat(5)}`;
  const policy = { schemaVersion: 1, domainId: 'alpha', credentials: [{
    id: 'fixture', domain: 'alpha', tokenHash: hashIntegrationToken(token),
    projectIds: ['alpha'], actions: [...ACTIONS], enabled: true, expiresAt: '2999-01-01T00:00:00Z',
  }] };
  const savePolicy = () => fs.writeFile(policyPath, JSON.stringify(policy));
  await savePolicy();
  const calls = { creates: 0, dispatches: 0 };
  const upstream = express();
  upstream.use(express.json());
  upstream.get('/config/providers', (_req, res) => res.json({ providers: [{ id: 'fixture', models: [{ id: 'echo' }] }] }));
  upstream.get('/config', (_req, res) => res.json({ model: 'fixture/echo' }));
  upstream.get('/agent', (_req, res) => res.json([{ name: 'build', mode: 'primary' }]));
  upstream.get('/session/:id/message', (_req, res) => res.json([]));
  upstream.post('/session', (_req, res) => { calls.creates += 1; res.json({ id: 'created' }); });
  upstream.post('/session/:id/prompt_async', (_req, res) => {
    calls.dispatches += 1;
    res.status(503).send('private-upstream-conversation');
  });
  const server = await new Promise((resolve) => {
    const listening = upstream.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const dependencies = {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'alpha', path: root }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:${server.address().port}${route}`,
    getOpenCodeAuthHeaders: () => ({}),
  };
  const sessionService = createOpenChamberSessionService(dependencies);
  const controlService = createOpenChamberControlService({ ...dependencies, sessionService });
  const app = express();
  registerIntegrationControlRoutes(app, { ...dependencies, controlService });
  return {
    request: supertest(app), token, calls, policy, savePolicy,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
      else process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = previous;
    },
  };
};
