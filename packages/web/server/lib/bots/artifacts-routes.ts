import { z } from 'zod';
import type { Router, Response } from '../shared/http-contracts.js';
import { BotArtifactError, artifactIdSchema, artifactPageSchema, artifactText } from './artifacts-contract.js';
import type { createBotArtifacts } from './artifacts-owner.js';

const scopeSchema = z.object({ projectId: artifactText, itemId: artifactText }).strict();
const detailSchema = scopeSchema.extend({ artifactId: artifactIdSchema }).strict();
const fail = (res: Response, error: Error) => {
  if (error instanceof BotArtifactError) return res.status(error.status).json({ code: error.code });
  return res.status(error instanceof z.ZodError ? 400 : 500).json({ code: 'BOT_ARTIFACT_READ_FAILED' });
};

export function registerBotArtifactRoutes(app: Router, { artifacts }: { readonly artifacts: Pick<ReturnType<typeof createBotArtifacts>, 'list' | 'read'> }) {
  const root = '/api/projects/:projectId/bots/items/:itemId/artifacts';
  app.get(root, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const scope = scopeSchema.parse(req.params);
      const page = artifactPageSchema.parse(req.query);
      return res.json(await artifacts.list(scope, page));
    } catch (error) {
      if (error instanceof Error) return fail(res, error);
      throw error;
    }
  });
  app.get(`${root}/:artifactId`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query).length) throw new BotArtifactError('BOT_ARTIFACT_QUERY_INVALID', 400);
      const { artifactId, ...scope } = detailSchema.parse(req.params);
      return res.json(await artifacts.read(scope, artifactId));
    } catch (error) {
      if (error instanceof Error) return fail(res, error);
      throw error;
    }
  });
}
