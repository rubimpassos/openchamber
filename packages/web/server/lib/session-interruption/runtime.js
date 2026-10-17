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
 * it. The UI parser is `wasInterruptedByInactivity` in
 * `packages/ui/src/lib/questions/orphanedQuestions.ts`.
 *
 * A `shutdown` interruption never reaches here: `translate-v2.js` drops it,
 * because OpenCode resumes that turn after the restart.
 *
 * A managed OpenCode restart that killed running turns is recorded by
 * `recordRestartInterruptions` (`reason: 'opencode-restart'`, see restart.js).
 */

import { OpenCode } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';
import { findInterruptedTool, RECENT_MESSAGE_LIMIT, restartInterruptionPatch } from './restart.js';
import { isPrioritySession } from './priority.js';

const READ_TIMEOUT_MS = 5_000;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {object} options
 * @param {(sessionID: string, patch: object, options: { directory: string }) => Promise<unknown>} options.persistMetadata
 * @param {(sessionID: string, decide: (metadata: object) => object | null, options: { directory: string }) => Promise<unknown>} [options.updateMetadata]
 * @param {() => { session: { get: Function }, message: { list: Function } }} [options.createClient] OpenCode client; session routes resolve their own location, so it names no directory.
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
  now = Date.now,
}) => {
  const processPayload = (payload, directory = '') => {
    if (payload?.type !== 'session.idle' || payload.properties?.aborted !== true) return;
    const sessionID = asNonEmptyString(payload.properties.sessionID);
    const reason = asNonEmptyString(payload.properties.reason);
    if (!sessionID || !reason) return;
    // A newer interruption replaces a restart record whole.
    const interruption = { reason, at: now(), cause: null, tool: null, resume: null };
    void Promise.resolve()
      .then(() => persistMetadata(sessionID, { openchamber: { interruption } }, { directory }))
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

  const readInterruptedTool = async (client, sessionID) => {
    try {
      const page = await client.message.list(
        { sessionID, limit: RECENT_MESSAGE_LIMIT, order: 'desc' },
        { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
      );
      return Array.isArray(page?.data) ? findInterruptedTool(page.data) : null;
    } catch (error) {
      console.warn(`[session-interruption] could not read the interrupted tool of ${sessionID}:`, errorMessage(error));
      return null;
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
      const [session, tool] = await Promise.all([readSession(client, sessionId), readInterruptedTool(client, sessionId)]);
      try {
        const { metadata } = await updateMetadata(sessionId, () => restartInterruptionPatch({ at, cause, tool }), { directory: session.directory ?? '' });
        return { sessionId, ...session, recorded: true, priority: isPrioritySession(metadata), at, cause, tool };
      } catch (error) {
        console.warn(`[session-interruption] could not record the restart on ${sessionId}:`, errorMessage(error));
        return { sessionId, ...session, recorded: false, priority: false, at, cause, tool };
      }
    }));
  };

  return { processPayload, recordRestartInterruptions };
};
