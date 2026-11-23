import express from 'express';
import { z } from 'zod';
import { createLocalMcpReader } from '../opencode/mcp-local-reader.js';
import { createMcpConfigRuntime } from '../opencode/mcp-config-runtime.js';
import { hasProperties } from '../shared/guards.js';
import type { Application } from '../shared/http-contracts.js';
import type { AgentUpstream } from './agent-upstream.js';
import {
  projectIdentitySchema, mcpNameSchema, MAX_SELECTION_MIRROR_BYTES,
  replaceSelectionMirror, readSelectionMirror,
} from '../protected-mcp/selection-mirror-documents.js';

export const AGENT_PROTECTED_MCP_ROUTE = '/api/openchamber/protected-mcp-agent';
const directorySchema = z.string().min(1).max(4096).refine((directory) => {
  if (!directory.startsWith('/')) return false;
  for (const character of directory) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
});
const identityReply = z.object({ identity: projectIdentitySchema }).strict();
const namesReply = z.object({ names: z.array(mcpNameSchema).max(256) }).strict();

type AgentMcpRouteOptions = {
  readonly agentServer: boolean;
  readonly dataDir: string;
  readonly listProjectDirectories: () => Promise<readonly string[]>;
};

export function registerAgentProtectedMcpRoutes(app: Application, { agentServer, dataDir, listProjectDirectories }: AgentMcpRouteOptions) {
  if (!agentServer) return;
  const local = createLocalMcpReader(dataDir);
  const config = createMcpConfigRuntime({ dataDir });
  const readRoute = <Schema extends typeof identityReply | typeof namesReply>(suffix: 'identity' | 'names', schema: Schema, read: (directory: string) => z.input<Schema>) => app.get(`${AGENT_PROTECTED_MCP_ROUTE}/${suffix}`, async (req, res) => {
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const parsed = directorySchema.safeParse(query.get('directory'));
    if (!parsed.success || query.getAll('directory').length !== 1 || [...query.keys()].some((key) => key !== 'directory')) {
      return res.status(400).json({ code: 'agent_mcp_invalid_request' });
    }
    try {
      if (!(await listProjectDirectories()).includes(parsed.data)) return res.status(403).json({ code: 'agent_project_not_registered' });
      const result = schema.safeParse(await read(parsed.data));
      if (!result.success) return res.status(502).json({ code: 'agent_mcp_invalid_response' });
      return res.json(result.data);
    } catch { return res.status(502).json({ code: 'agent_mcp_unavailable' }); }
  });
  readRoute('identity', identityReply, (directory) => ({ identity: local.resolve(directory).identity }));
  readRoute('names', namesReply, (directory) => ({ names: config.listMcpConfigs(directory).map((entry) => entry.name) }));
  const parser = express.json({ limit: MAX_SELECTION_MIRROR_BYTES });
  app.put(`${AGENT_PROTECTED_MCP_ROUTE}/selections`, (req, res, next) => {
    parser(req, res, (error) => error ? res.status(hasProperties(error) && error.status === 413 ? 413 : 400).json({ code: 'agent_mcp_invalid_request' }) : next());
  }, async (req, res) => {
    try {
      if (new URL(req.originalUrl, 'http://localhost').search) return res.status(400).json({ code: 'agent_mcp_invalid_request' });
      await replaceSelectionMirror(dataDir, req.body);
      return res.json({ mirrored: true });
    } catch (error) {
      return res.status(error instanceof z.ZodError ? 400 : 503).json({ code: 'agent_mcp_mirror_failed' });
    }
  });
}

type McpUpstream = Pick<AgentUpstream, 'json'>;

export async function readAgentProjectIdentity(upstream: McpUpstream, directory: string) {
  const query = new URLSearchParams({ directory: directorySchema.parse(directory) });
  return identityReply.parse(await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/identity?${query}`, { timeoutMs: 5000 })).identity;
}

export async function readAgentOrdinaryMcpNames(upstream: McpUpstream, directory: string | null | undefined) {
  const query = new URLSearchParams({ directory: directorySchema.parse(directory) });
  return namesReply.parse(await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/names?${query}`, { timeoutMs: 5000 })).names;
}

type MirrorFailure = 'selection_mirror_too_large' | 'selection_mirror_unavailable';
type McpMirrorOptions = { readonly upstream: McpUpstream; readonly dataDir: string; readonly log?: (code: MirrorFailure) => void };

export function createProtectedMcpMirror({ upstream, dataDir, log = (code) => console.warn('[protected-mcp] selection_mirror_failed', { code }) }: McpMirrorOptions) {
  let pending = Promise.resolve();
  const push = () => {
    pending = pending.then(async () => {
      try {
        const snapshot = await readSelectionMirror(dataDir);
        const body = JSON.stringify(snapshot);
        if (Buffer.byteLength(body) > MAX_SELECTION_MIRROR_BYTES) { log('selection_mirror_too_large'); return; }
        await upstream.json(`${AGENT_PROTECTED_MCP_ROUTE}/selections`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body,
        });
      } catch { log('selection_mirror_unavailable'); }
    });
    return pending;
  };
  return { push, flush: () => pending };
}
