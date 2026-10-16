/**
 * Remembers why OpenCode interrupted a session's last turn.
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
 */

import { asNonEmptyString } from '../shared/guards.js';

/**
 * @param {object} options
 * @param {(sessionID: string, patch: object, options: { directory: string }) => Promise<unknown>} options.persistMetadata
 * @param {() => number} [options.now]
 */
export const createSessionInterruptionRuntime = ({ persistMetadata, now = Date.now }) => {
  const processPayload = (payload, directory = '') => {
    if (payload?.type !== 'session.idle' || payload.properties?.aborted !== true) return;
    const sessionID = asNonEmptyString(payload.properties.sessionID);
    const reason = asNonEmptyString(payload.properties.reason);
    if (!sessionID || !reason) return;
    void Promise.resolve()
      .then(() => persistMetadata(sessionID, { openchamber: { interruption: { reason, at: now() } } }, { directory }))
      .catch((error) => {
        console.warn('[session-interruption] could not record the interruption reason:', error?.message ?? error);
      });
  };

  return { processPayload };
};
