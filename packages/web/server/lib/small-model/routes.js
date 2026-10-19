import os from 'node:os';
import path from 'node:path';
import { createDiskCache } from '../disk-cache.js';

const TEXT_CACHE_MAX_BYTES = 20 * 1024 * 1024;

const defaultTextCacheDir = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR ? path.resolve(process.env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'),
  'cache',
  'small-model',
);

export function registerSmallModelRoutes(app, { getSmallModelService, textCacheDir = defaultTextCacheDir() }) {
  // Only callers that ask with `cache: true` share it: a session title or a
  // commit message is expected to come out fresh each time.
  const textCache = createDiskCache({ dir: textCacheDir, maxBytes: TEXT_CACHE_MAX_BYTES, label: 'small-model' });
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders } = await getSmallModelService();
      const directory = typeof req.query.directory === 'string' ? req.query.directory : undefined;
      const resolved = await describeSmallModel({
        directory,
        preferredProviderID: typeof req.query.providerID === 'string' ? req.query.providerID : undefined,
        preferredModelID: typeof req.query.modelID === 'string' ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(directory),
      });
    } catch (error) {
      console.error('Failed to resolve small model:', error);
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, cache } = req.body || {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
        cache: cache === true ? textCache : null,
      });
      res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      res.status(statusCode).json({
        error: statusCode === 404 || error?.code === 'small-model-unavailable'
          ? (error.message || 'No small model is available')
          : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
        ...(error?.code ? { code: error.code } : {}),
      });
    }
  });
}
