import { z } from 'zod';
import { registerSettingsRoutes } from '../opencode/routes.js';
import { registerSettingsUtilityRoutes } from '../server-frame/core-routes.js';
import { registerProtectedMcpRoutes } from '../protected-mcp/routes.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { registerSystemStatsRoutes } from '../system-stats/routes.js';
import { createSystemStatsCollector } from '../system-stats/collect.js';
import { randomUUID } from 'node:crypto';
import { readAgentProjectIdentity, readAgentOrdinaryMcpNames } from './protected-mcp.js';
import { registerFrontDoorTrackedItemsRoutes } from './tracked-items.js';
import type { Application } from '../shared/http-contracts.js';
import type { SettingsUtilityDependencies } from '../server-frame/core-routes.js';
import type { ScheduledTaskRouteDependencies } from '../scheduled-tasks/routes.js';
import type { createSettingsHelpers } from '../settings/settings-helpers.js';
import type { createSettingsRuntime } from '../settings/settings-runtime.js';
import type { createFrontDoorTrackedItems } from './tracked-items.js';

type LocalRouteDependencies = SettingsUtilityDependencies
  & Pick<ReturnType<typeof createSettingsRuntime>, 'readSettingsFromDiskMigrated' | 'persistSettings'>
  & Pick<ReturnType<typeof createSettingsHelpers>, 'formatSettingsResponse'>
  & Pick<Parameters<typeof createSystemStatsCollector>[0], 'os' | 'fsPromises'>
  & Pick<ScheduledTaskRouteDependencies, 'getOpenChamberEventClients' | 'writeSseEvent'>
  & Pick<Parameters<typeof registerSystemStatsRoutes>[1], 'openchamberVersion'>
  & {
    readonly agentUpstream: Parameters<typeof readAgentProjectIdentity>[0];
    readonly frontDoorTrackedItems: ReturnType<typeof createFrontDoorTrackedItems>;
    readonly protectedMcpMirror: NonNullable<Parameters<typeof registerProtectedMcpRoutes>[1]['selectionMirror']>;
    readonly openchamberDataDir: string;
    readonly path: Pick<typeof import('node:path'), 'posix'>;
    readonly listConfiguredProjects: () => Promise<readonly { readonly path: string }[]>;
    readonly agentServer?: boolean | undefined;
  };

const pathSchema = z.string().trim().min(1).max(4096).refine((value) => value.startsWith('/') && !value.includes('\0') && !/^\/spaces(?:\/|$)/.test(value));
const directorySchema = z.object({ path: pathSchema, create: z.literal(false).optional() });
const registeredProjectSchema = z.object({ path: z.string() });
const registryErrorSchema = z.object({ code: z.string().optional(), status: z.number().optional() });

export const createFrontDoorLocalRegistrar = (clientReloadDelayMs: number) => (
  app: Application,
  dependencies: Omit<LocalRouteDependencies, 'clientReloadDelayMs'> & {
    readonly botsServer?: { registerRoutes(app: Application): void } | null;
  },
) => {
  registerFrontDoorLocalRoutes(app, { ...dependencies, clientReloadDelayMs });
  dependencies.botsServer?.registerRoutes(app);
};

export function registerFrontDoorLocalRoutes(app: Application, deps: LocalRouteDependencies) {
  registerFrontDoorTrackedItemsRoutes(app, { service: deps.frontDoorTrackedItems });
  registerSettingsRoutes(app, deps);
  registerSettingsUtilityRoutes(app, deps);
  registerSystemStatsRoutes(app, { collector: createSystemStatsCollector({ os: deps.os, fsPromises: deps.fsPromises, process }), openchamberVersion: deps.openchamberVersion, isOpenCodeRunning: () => false });
  app.get('/api/openchamber/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const connectionId = randomUUID();
    const client = Object.assign(res, { openchamberBrowserCapable: req.query.browser === '1', openchamberConnectionId: connectionId });
    const clients = deps.getOpenChamberEventClients();
    clients.add(client);
    deps.frontDoorTrackedItems.openConnection(connectionId);
    deps.writeSseEvent(res, { type: 'openchamber:event-stream-ready', properties: { connectedAt: Date.now(), connectionId } });
    const heartbeat = setInterval(() => deps.writeSseEvent(res, { type: 'openchamber:heartbeat', properties: { timestamp: Date.now() } }), 25_000);
    res.once('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
      void deps.frontDoorTrackedItems.closeConnection(connectionId).catch(() => {});
    });
  });
  registerProtectedMcpRoutes(app, {
    dataDir: deps.openchamberDataDir,
    isSupported: () => true,
    resolveOptionalProjectDirectory: async (req) => {
      const candidate = req.query.directory ?? req.get('x-opencode-directory');
      if (!candidate) return { directory: null };
      const parsed = pathSchema.safeParse(candidate);
      if (!parsed.success) return { error: 'Invalid project directory' };
      const projects = await deps.listConfiguredProjects();
      if (!projects.some((project) => project.path === parsed.data)) return { error: 'Project directory is not registered' };
      return { directory: parsed.data };
    },
    resolveProjectIdentity: (directory) => readAgentProjectIdentity(deps.agentUpstream, directory),
    listOrdinaryMcpNames: (directory) => readAgentOrdinaryMcpNames(deps.agentUpstream, directory),
    selectionMirror: deps.protectedMcpMirror,
  });
  app.post('/api/openchamber/directory', async (req, res) => {
    const parsed = directorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: 'project_path_refused', error: 'An absolute existing project path is required. Directory creation runs on the agent server.' });
    const directory = deps.path.posix.normalize(parsed.data.path);
    try {
      const current = await deps.readSettingsFromDiskMigrated();
      const projects = Array.isArray(current.projects) ? current.projects : [];
      const id = createProjectIdFromPath(directory);
      const registered = projects.some((project) => registeredProjectSchema.safeParse(project).data?.path === directory);
      const next = registered ? projects : [...projects, { id, path: directory, addedAt: Date.now(), lastOpenedAt: Date.now() }];
      const settings = await deps.persistSettings({ projects: next, activeProjectId: id, lastDirectory: directory });
      res.json({ success: true, restarted: false, path: directory, settings });
    } catch (error) {
      const failure = registryErrorSchema.safeParse(error).data;
      const code = failure?.code && /^(?:share_project_|project_path_|project_registry_|space_project_refused)/.test(failure.code) ? failure.code : 'project_registry_failed';
      res.status(failure?.status ?? 503).json({ code, error: code });
    }
  });
}
