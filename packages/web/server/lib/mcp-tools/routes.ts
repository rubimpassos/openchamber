import type { Application } from '../shared/http-contracts.js';
import type { createMcpToolsRuntime } from './runtime.js';

const hasStatusCode = (error: unknown): error is Error & { readonly statusCode: number } =>
  error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number';

export const registerMcpToolRoutes = (app: Application, { mcpToolsRuntime }: {
  readonly mcpToolsRuntime: ReturnType<typeof createMcpToolsRuntime>;
}) => {
  app.get('/api/projects/:projectId/mcp-tools', async (req, res) => {
    try {
      return res.json(await mcpToolsRuntime.getProjectTools(req.params.projectId ?? ''));
    } catch (error) {
      const statusCode = hasStatusCode(error) ? error.statusCode : 502;
      return res.status(statusCode).json({ error: 'Unable to read project MCP tools' });
    }
  });
};
