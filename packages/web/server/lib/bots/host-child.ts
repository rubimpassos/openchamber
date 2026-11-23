import { createBotIsolatedToolInbox, registerBotIsolatedToolRoutes } from './isolated-tools.js';
import type { Application } from '../shared/http-contracts.js';
import type { SessionMetadata, createSessionMetadataStore } from '../openchamber-sessions/session-metadata-store.js';

type ChildOptions = {
  readonly dataDir: string;
  readonly updateMetadata: (sessionId: string, patch: SessionMetadata) =>
    ReturnType<ReturnType<typeof createSessionMetadataStore>['setSessionMetadata']> | Promise<void>;
};

export function createBotChildServer({ dataDir, updateMetadata }: ChildOptions) {
  const inbox = createBotIsolatedToolInbox({ dataDir, onPending: async ({ sessionId, requestId }) => {
    await updateMetadata(sessionId, { openchamber: { botToolPending: requestId } });
  } });
  return {
    handleTool: inbox.request,
    registerRoutes: (app: Application) => {
      registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace: () => true });
      app.use('/api/projects/:projectId/bots', (_req, res) => res.status(501).json({ code: 'BOT_HOST_REQUIRED' }));
    },
  };
}
