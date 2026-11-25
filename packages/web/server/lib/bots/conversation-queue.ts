import path from 'node:path';
import { z } from 'zod';
import { createMessageQueueRuntime } from '../message-queue/runtime.js';
import type { MessageQueueOptions } from '../message-queue/runtime.js';
import type { Application, RequestHandler } from '../shared/http-contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { createBotsHost } from './host.js';
import { requireLocalRuntime } from '../server-frame/local-runtime.js';

export function createBotConversationQueue(options: Pick<MessageQueueOptions,
  'dataDir' | 'globalEventHub' | 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'fetchImpl' | 'broadcastGlobalUiEvent' | 'assertDispatchAdmission'>) {
  return createMessageQueueRuntime({ ...options, dataDir: path.join(options.dataDir, 'bots', 'conversation-queue'),
    queueOwner: 'bot-conversation' });
}

const nativeSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  sessions: z.array(z.object({ sessionId: z.string() }).catchall(z.json())),
});
type Options = {
  readonly readNative: () => Promise<JsonValue>;
  readonly readConversations: () => Promise<ReturnType<ReturnType<typeof createMessageQueueRuntime>['snapshot']>>;
  readonly ownsSession: (sessionId: string) => Promise<boolean>;
};

export const createBotConversationQueueRead = (options: Options): RequestHandler => async (req, res, next) => {
  const url = new URL(req.originalUrl || req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname.toLowerCase() !== '/api/message-queue'
    || req.get('x-opencode-directory') || url.search) return next();
  try {
    const [native, conversation] = await Promise.all([options.readNative().then((value) => nativeSnapshotSchema.parse(value)), options.readConversations()]);
    const sessions = [];
    for (const session of native.sessions) if (!await options.ownsSession(session.sessionId)) sessions.push(session);
    return res.json({ revision: native.revision, sessions, conversation });
  } catch (error) { return next(error); }
};

export function registerBotConversationGuards(
  app: Application, getHost: () => ReturnType<typeof createBotsHost> | null, readNative: Options['readNative'] | null,
) {
  app.use((req, res, next) => {
    const host = getHost();
    return host ? host.conversationGuard(req, res, next) : next();
  });
  if (readNative) app.use(createBotConversationQueueRead({
    readNative,
    readConversations: () => requireLocalRuntime(getHost(), 'Bot host').conversationQueueSnapshot(),
    ownsSession: (sessionId) => requireLocalRuntime(getHost(), 'Bot host').isConversationSession(sessionId),
  }));
}
