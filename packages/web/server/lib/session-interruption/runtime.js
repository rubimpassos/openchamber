/**
 * Remembers why a session's last turn was interrupted.
 *
 * `session.execution.interrupted` says why (`user`, `superseded`,
 * `inactivity`), but OpenCode keeps the reason nowhere: the idle row and the
 * session's `idle_outcome` only say `interrupted`. The UI needs it after a
 * reload to tell a question killed by OpenCode's inactivity eviction (shown
 * again as answerable) from one the user stopped (left alone). This runtime
 * writes the reason to `metadata.openchamber.interruption` as `{ reason, at }`.
 * `at` is taken when the event arrives, so it is never older than the
 * session's `time.idle` for the same turn; a later turn moves `time.idle` past
 * it. The UI parser is `inactivityInterruptionAt` in
 * `packages/ui/src/lib/questions/orphanedQuestions.ts`.
 *
 * A `shutdown` interruption never reaches here: `translate-v2.js` drops it,
 * because OpenCode resumes that turn after the restart.
 *
 * A managed OpenCode restart that killed running turns is recorded by
 * `recordRestartInterruptions` (`reason: 'opencode-restart'`, see restart.js).
 */

import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { asNonEmptyString } from '../shared/guards.js';
import { findCutAssistantMessageID, findInterruptedTool, findPendingQuestion, pendingQuestionRecord, RECENT_MESSAGE_LIMIT, restartInterruptionPatch } from './restart.js';
import { isPrioritySession } from './priority.js';

const READ_TIMEOUT_MS = 5_000;

const pendingQuestionAtSchema = z.object({ openchamber: z.object({ pendingQuestion: z.object({ at: z.number() }) }) });

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {object} options
 * @param {(sessionID: string, patch: object, options: { directory: string }) => Promise<unknown>} options.persistMetadata
 * @param {(sessionID: string, decide: (metadata: object) => object | null, options: { directory: string }) => Promise<unknown>} [options.updateMetadata]
 * @param {() => { session: { get: Function }, message: { list: Function } }} [options.createClient] OpenCode client; session routes resolve their own location, so it names no directory.
 * @param {(question: { sessionId: string, directory: string | null, sessionTitle: string | null, title: string }) => void} [options.onPendingQuestion]
 *   A cut-off question now waits for the user (feeds the notification center).
 * @param {() => number} [options.now]
 */
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
}) => {
  // Sessions this server gave a pending question, so a busy status reads the
  // store only for them. After a server restart the UI's own clear (answer,
  // send, dismiss) still applies.
  const pendingQuestionSessions = new Set();

  const readRecentMessages = async (client, sessionID) => {
    const page = await client.message.list(
      { sessionID, limit: RECENT_MESSAGE_LIMIT, order: 'desc' },
      { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
    );
    return Array.isArray(page?.data) ? page.data : [];
  };

  /**
   * The question an inactivity eviction cut off, read from the session's
   * newest messages; null for any other reason or when they cannot be read.
   */
  const readEvictedQuestion = async (sessionID, reason) => {
    if (reason !== 'inactivity') return null;
    try {
      return findPendingQuestion(await readRecentMessages(createClient(), sessionID));
    } catch (error) {
      console.warn(`[session-interruption] could not read the question of ${sessionID}:`, errorMessage(error));
      return null;
    }
  };

  /**
   * A turn running again means the question was answered or superseded:
   * the user replied, or a message came in from anywhere (CLI, TUI, another
   * client). Decided in the store's queue, so a record written after the
   * turn started stays.
   */
  const settlePendingQuestion = (sessionID, directory, startedAt) => {
    if (!updateMetadata) return;
    void updateMetadata(sessionID, (metadata) => {
      const at = pendingQuestionAtSchema.safeParse(metadata).data?.openchamber.pendingQuestion.at;
      return at !== undefined && at <= startedAt ? { openchamber: { pendingQuestion: null } } : null;
    }, { directory }).catch((error) => {
      console.warn(`[session-interruption] could not clear the pending question of ${sessionID}:`, errorMessage(error));
    });
  };

  const processPayload = (payload, directory = '') => {
    if (payload?.type === 'session.status' && payload.properties?.status?.type === 'busy') {
      const sessionID = asNonEmptyString(payload.properties.sessionID);
      if (sessionID && pendingQuestionSessions.has(sessionID)) {
        pendingQuestionSessions.delete(sessionID);
        settlePendingQuestion(sessionID, directory, now());
      }
      return;
    }
    if (payload?.type !== 'session.idle' || payload.properties?.aborted !== true) return;
    const sessionID = asNonEmptyString(payload.properties.sessionID);
    const reason = asNonEmptyString(payload.properties.reason);
    if (!sessionID || !reason) return;
    // A newer interruption replaces a restart record whole.
    const interruption = { reason, at: now(), cause: null, tool: null, resume: null };
    void readEvictedQuestion(sessionID, reason)
      .then(async (question) => {
        const pendingQuestion = pendingQuestionRecord(question, { cause: reason, at: interruption.at });
        await persistMetadata(sessionID, { openchamber: { interruption, pendingQuestion } }, { directory });
        if (question) pendingQuestionSessions.add(sessionID);
        if (question) onPendingQuestion({ sessionId: sessionID, directory: directory || null, sessionTitle: null, title: question.title });
      })
      .catch((error) => {
        console.warn('[session-interruption] could not record the interruption reason:', error?.message ?? error);
      });
  };

  const readSession = async (client, sessionID) => {
    try {
      const session = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      return {
        directory: asNonEmptyString(session?.location?.directory ?? session?.directory) ?? null,
        title: asNonEmptyString(session?.title) ?? null,
      };
    } catch (error) {
      console.warn(`[session-interruption] could not read session ${sessionID} after the restart:`, errorMessage(error));
      return { directory: null, title: null };
    }
  };

  const readCutTurn = async (client, sessionID) => {
    try {
      const records = await readRecentMessages(client, sessionID);
      return { tool: findInterruptedTool(records), messageID: findCutAssistantMessageID(records), question: findPendingQuestion(records) };
    } catch (error) {
      console.warn(`[session-interruption] could not read the interrupted tool of ${sessionID}:`, errorMessage(error));
      return { tool: null, messageID: null, question: null };
    }
  };

  /**
   * Writes the restart record on every session the restart interrupted. Each
   * session is read and written on its own: a failed read records no tool, a
   * failed write is logged, and neither touches the other sessions. Resolves
   * `[{ sessionId, directory, title, recorded, priority }]` in the order
   * given: directory and title are null when the session could not be read,
   * `recorded` says the record was written, and `priority` is read from the
   * metadata that write returned.
   */
  const recordRestartInterruptions = async ({ sessionIds, cause }) => {
    if (sessionIds.length === 0) return [];
    const at = now();
    const client = createClient();
    return Promise.all(sessionIds.map(async (sessionId) => {
      const [session, { tool, messageID, question }] = await Promise.all([readSession(client, sessionId), readCutTurn(client, sessionId)]);
      try {
        const { metadata } = await updateMetadata(sessionId, () => restartInterruptionPatch({ at, cause, tool, messageID, question }), { directory: session.directory ?? '' });
        if (question) pendingQuestionSessions.add(sessionId);
        if (question) onPendingQuestion({ sessionId, directory: session.directory, sessionTitle: session.title, title: question.title });
        return { sessionId, ...session, recorded: true, priority: isPrioritySession(metadata), at, cause, tool };
      } catch (error) {
        console.warn(`[session-interruption] could not record the restart on ${sessionId}:`, errorMessage(error));
        return { sessionId, ...session, recorded: false, priority: false, at, cause, tool };
      }
    }));
  };

  return { processPayload, recordRestartInterruptions };
};
