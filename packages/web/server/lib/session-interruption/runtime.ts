
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { asNonEmptyString, hasProperties } from '../shared/guards.js';
import { findCutAssistantMessageID, findInterruptedTool, findPendingQuestion, pendingQuestionRecord, RECENT_MESSAGE_LIMIT, restartInterruptionPatch } from './restart.js';
import { isPrioritySession } from './priority.js';
import type { UpdateMetadata } from './contracts.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { JsonValue } from '../event-stream/contracts.js';

interface SessionRead {
  readonly location?: { readonly directory?: string };
  readonly directory?: string;
  readonly title?: string;
}
interface RecoveryClearPatch { pendingQuestion?: null; interruption?: null }

interface InterruptionClient {
  readonly session: { readonly get: (input: { sessionID: string }, options: { signal: AbortSignal }) => Promise<SessionRead | null | undefined> };
  readonly message: { readonly list: (input: { sessionID: string; limit: number; order: 'desc' }, options: { signal: AbortSignal }) => Promise<{ readonly data?: readonly unknown[] }> };
}
interface InterruptionOptions {
  readonly persistMetadata: (sessionID: string, patch: SessionMetadata, options: { directory: string }) => Promise<SessionMetadata>;
  readonly updateMetadata: UpdateMetadata;
  readonly buildOpenCodeUrl: (route: string, query: string) => string;
  readonly getOpenCodeAuthHeaders: () => Record<string, string>;
  readonly createClient?: () => InterruptionClient;
  readonly onPendingQuestion?: (question: { sessionId: string; directory: string | null; sessionTitle: string | null; title: string }) => void;
  readonly now?: () => number;
}
interface PendingRecovery {
  recording: boolean;
  startedAt: number | null;
}

const READ_TIMEOUT_MS = 5_000;

const pendingQuestionAtSchema = z.object({ openchamber: z.object({ pendingQuestion: z.object({ at: z.number() }) }) });
const restartInterruptionAtSchema = z.object({ openchamber: z.object({ interruption: z.object({ reason: z.literal('opencode-restart'), at: z.number() }) }) });

export const createSessionInterruptionRuntime = ({
  persistMetadata,
  updateMetadata,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createClient = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: { ...getOpenCodeAuthHeaders() },
  }),
  onPendingQuestion = () => {},
  now = Date.now,
}: InterruptionOptions) => {
  const pendingRecoverySessions = new Map<string | null, PendingRecovery>();

  const readRecentMessages = async (client: InterruptionClient, sessionID: string) => {
    const page = await client.message.list(
      { sessionID, limit: RECENT_MESSAGE_LIMIT, order: 'desc' },
      { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
    );
    return Array.isArray(page?.data) ? page.data : [];
  };

  const readEvictedQuestion = async (sessionID: string, reason: string) => {
    if (reason !== 'inactivity') return null;
    try {
      return findPendingQuestion(await readRecentMessages(createClient(), sessionID));
    } catch (error) {
      console.warn(`[session-interruption] could not read the question of ${sessionID}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const settlePendingRecovery = (sessionID: string, directory: string, startedAt: number, recovery: PendingRecovery) => {
    if (!updateMetadata) return;
    return updateMetadata(sessionID, (metadata) => {
      if (pendingRecoverySessions.get(sessionID) !== recovery) return null;
      const questionAt = pendingQuestionAtSchema.safeParse(metadata).data?.openchamber.pendingQuestion.at;
      const restartAt = restartInterruptionAtSchema.safeParse(metadata).data?.openchamber.interruption.at;
      const openchamber: RecoveryClearPatch = {};
      if (questionAt !== undefined && questionAt <= startedAt) openchamber.pendingQuestion = null;
      if (restartAt !== undefined && restartAt <= startedAt) openchamber.interruption = null;
      return Object.keys(openchamber).length > 0 ? { openchamber } : null;
    }, { directory }).catch((error) => {
      console.warn(`[session-interruption] could not clear recovery details of ${sessionID}:`, error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (pendingRecoverySessions.get(sessionID) === recovery) pendingRecoverySessions.delete(sessionID);
    });
  };

  const processPayload = (payload: JsonValue, directory = '') => {
    if (!hasProperties(payload)) return;
    const properties = hasProperties(payload.properties) ? payload.properties : undefined;
    const status = hasProperties(properties?.status) ? properties.status : undefined;
    if (payload.type === 'session.status' && status?.type === 'busy') {
      const sessionID = asNonEmptyString(properties?.sessionID);
      const recovery = pendingRecoverySessions.get(sessionID);
      if (recovery && recovery.startedAt === null) {
        recovery.startedAt = now();
        if (!recovery.recording && sessionID) void settlePendingRecovery(sessionID, directory, recovery.startedAt, recovery);
      }
      return;
    }
    if (payload.type !== 'session.idle' || properties?.aborted !== true) return;
    const sessionID = asNonEmptyString(properties.sessionID);
    const reason = asNonEmptyString(properties.reason);
    if (!sessionID || !reason) return;
    const interruption = { reason, at: now(), cause: null, tool: null, resume: null };
    void readEvictedQuestion(sessionID, reason)
      .then(async (question) => {
        const pendingQuestion = pendingQuestionRecord(question, { cause: reason, at: interruption.at });
        await persistMetadata(sessionID, { openchamber: { interruption, pendingQuestion } }, { directory });
        if (question) pendingRecoverySessions.set(sessionID, { recording: false, startedAt: null });
        if (question) onPendingQuestion({ sessionId: sessionID, directory: directory || null, sessionTitle: null, title: question.title });
      })
      .catch((error) => {
        console.warn('[session-interruption] could not record the interruption reason:', (hasProperties(error) ? error.message : undefined) ?? error);
      });
  };

  const readSession = async (client: InterruptionClient, sessionID: string) => {
    try {
      const session = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      const location = hasProperties(session) && hasProperties(session.location) ? session.location : undefined;
      return {
        directory: asNonEmptyString(location?.directory ?? (hasProperties(session) ? session.directory : undefined)) ?? null,
        title: asNonEmptyString(hasProperties(session) ? session.title : undefined) ?? null,
      };
    } catch (error) {
      console.warn(`[session-interruption] could not read session ${sessionID} after the restart:`, error instanceof Error ? error.message : String(error));
      return { directory: null, title: null };
    }
  };

  const readCutTurn = async (client: InterruptionClient, sessionID: string) => {
    try {
      const records = await readRecentMessages(client, sessionID);
      return { tool: findInterruptedTool(records), messageID: findCutAssistantMessageID(records), question: findPendingQuestion(records) };
    } catch (error) {
      console.warn(`[session-interruption] could not read the interrupted tool of ${sessionID}:`, error instanceof Error ? error.message : String(error));
      return { tool: null, messageID: null, question: null };
    }
  };

  const recordRestartInterruptions = async ({ sessionIds, cause }: { readonly sessionIds: readonly string[]; readonly cause: string }) => {
    if (sessionIds.length === 0) return [];
    const at = now();
    const client = createClient();
    return Promise.all(sessionIds.map(async (sessionId) => {
      const recovery: PendingRecovery = { recording: true, startedAt: null };
      pendingRecoverySessions.set(sessionId, recovery);
      const [session, { tool, messageID, question }] = await Promise.all([readSession(client, sessionId), readCutTurn(client, sessionId)]);
      try {
        const { metadata, changed } = await updateMetadata(sessionId, () => {
          if (pendingRecoverySessions.get(sessionId) !== recovery) return null;
          const patch = restartInterruptionPatch({ at, cause, tool, messageID, question });
          if (recovery.startedAt !== null) {
            patch.openchamber.interruption = null;
            patch.openchamber.pendingQuestion = null;
          }
          return patch;
        }, { directory: session.directory ?? '' });
        recovery.recording = false;
        if (recovery.startedAt !== null) await settlePendingRecovery(sessionId, session.directory ?? '', recovery.startedAt, recovery);
        if (question && recovery.startedAt === null && pendingRecoverySessions.get(sessionId) === recovery) {
          onPendingQuestion({ sessionId, directory: session.directory, sessionTitle: session.title, title: question.title });
        }
        return { sessionId, ...session, recorded: changed !== false, priority: isPrioritySession(metadata), at, cause, tool };
      } catch (error) {
        if (pendingRecoverySessions.get(sessionId) === recovery) pendingRecoverySessions.delete(sessionId);
        console.warn(`[session-interruption] could not record the restart on ${sessionId}:`, error instanceof Error ? error.message : String(error));
        return { sessionId, ...session, recorded: false, priority: false, at, cause, tool };
      }
    }));
  };

  return { processPayload, recordRestartInterruptions };
};
