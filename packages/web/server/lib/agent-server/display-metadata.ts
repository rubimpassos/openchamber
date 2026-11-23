import path from 'node:path';

import { z } from 'zod';

import { createNotificationTemplateRuntime } from '../notifications/template-runtime.js';
import type { NotificationTemplateDependencies } from '../notifications/template-runtime.js';
import type { Application } from '../shared/http-contracts.js';
import type { AgentUpstream } from './agent-upstream.js';

type DisplayMetadataDependencies = Readonly<Pick<NotificationTemplateDependencies,
  'readSettingsFromDisk' | 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'resolveGitBinaryForSpawn' | 'resolvePrimaryWorktreeRoot' | 'chatRoots'>>;

const ROUTE = '/api/openchamber/display-metadata';
const directorySchema = z.string().min(1).max(4096)
  .refine((directory) => !directory.includes('\0') && path.isAbsolute(directory));
const replySchema = z.object({ projectName: z.string().max(256), branch: z.string().max(256) });

/** Runs only in the server account that can read the requested project. */
export function registerDisplayMetadataRoute(app: Application, dependencies: DisplayMetadataDependencies) {
  const templates = createNotificationTemplateRuntime(dependencies);
  app.get(ROUTE, async (req, res) => {
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const directory = directorySchema.safeParse(query.get('directory'));
    if (query.getAll('directory').length !== 1 || [...query.keys()].some((key) => key !== 'directory') || !directory.success) {
      return res.status(400).json({ error: 'Invalid directory', code: 'invalid_directory' });
    }
    const variables = await templates.buildTemplateVariables({ properties: { directory: directory.data } });
    res.json(replySchema.parse({ projectName: variables.project_name.slice(0, 256), branch: variables.branch.slice(0, 256) }));
  });
}

/** The upstream transport owns authentication, response bounds and deadlines. */
export async function readAgentDisplayMetadata(upstream: Pick<AgentUpstream, 'json'>, directory: string) {
  const validated = directorySchema.parse(directory);
  const result = await upstream.json(`${ROUTE}?${new URLSearchParams({ directory: validated })}`, { timeoutMs: 5000 });
  return replySchema.parse(result);
}
