import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

/**
 * A question a managed OpenCode restart or the inactivity eviction cut off,
 * which the user can still answer. The server writes it to
 * `metadata.openchamber.pendingQuestion` when it records the interruption
 * (`packages/web/server/lib/session-interruption/restart.js`,
 * `findPendingQuestion`) and clears it when the session runs again. The UI
 * clears it when the question is answered or dismissed and with any message
 * the user sends.
 *
 * It travels with the session record, so the sidebar, the phone's list and
 * the tray show the session as waiting for the user without loading its
 * messages: OpenCode reports the session idle, which is true for OpenCode and
 * not for the user.
 */
const pendingQuestionSchema = z.object({
  openchamber: z.object({
    pendingQuestion: z.object({
      messageID: z.string().min(1),
      callID: z.string().min(1),
      title: z.string().catch(''),
      cause: z.enum(['opencode-restart', 'inactivity']),
      at: z.number(),
    }),
  }),
});

export type PendingQuestion = z.infer<typeof pendingQuestionSchema>['openchamber']['pendingQuestion'];

export function getPendingQuestion(session: Session | null | undefined): PendingQuestion | null {
  return pendingQuestionSchema.safeParse(session?.metadata).data?.openchamber.pendingQuestion ?? null;
}

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/** The metadata without the pending question; everything else stays. */
export function withoutPendingQuestion(metadata: Metadata): Metadata {
  if (!pendingQuestionSchema.safeParse(metadata).success) return metadata;
  const namespace = { ...(openchamberSchema.safeParse(metadata).data?.openchamber ?? {}) };
  delete namespace.pendingQuestion;
  return { ...metadata, openchamber: namespace };
}
