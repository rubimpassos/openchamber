import { createBotIsolatedToolInbox, registerBotIsolatedToolRoutes } from './isolated-tools.js';
import type { Application } from '../shared/http-contracts.js';
import { createBotArtifactExecution } from './artifacts-execution.js';

type ChildOptions = {
  readonly readArtifactPage?: Parameters<typeof createBotArtifactExecution>[0]['readPage'];
  readonly dataDir: string;
  readonly readSession: Parameters<typeof createBotArtifactExecution>[0]['readSession'];
  readonly updateMetadata: Parameters<typeof createBotArtifactExecution>[0]['updateMetadata'];
};

export function createBotChildServer({ dataDir, updateMetadata, readSession, readArtifactPage }: ChildOptions) {
  let artifactOptions: Parameters<typeof createBotArtifactExecution>[0] = { dataDir, privatePlacement: 'space', updateMetadata, readSession };
  if (readArtifactPage) artifactOptions = { ...artifactOptions, readPage: readArtifactPage };
  const artifacts = createBotArtifactExecution(artifactOptions);
  const inbox = createBotIsolatedToolInbox({ dataDir, onPending: async ({ sessionId, requestId }) => {
    await updateMetadata(sessionId, { openchamber: { botToolPending: requestId } });
  } });
  return {
    artifacts,
    stop: () => artifacts.capture.flush(),
    handleTool: inbox.request,
    registerRoutes: (app: Application) => {
      registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace: () => true });
      artifacts.registerRoutes(app, 'space');
      app.use('/api/projects/:projectId/bots', (_req, res) => res.status(501).json({ code: 'BOT_HOST_REQUIRED' }));
    },
  };
}
