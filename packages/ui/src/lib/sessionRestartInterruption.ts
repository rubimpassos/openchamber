import { z } from 'zod';
import type { Metadata, Session } from '@/lib/opencode/model';

/**
 * A managed OpenCode restart killed this session's running turn. The server
 * writes `session.metadata.openchamber.interruption` with
 * `reason: 'opencode-restart'` (owned by
 * `packages/web/server/lib/session-interruption/restart.js`); the same key
 * with any other reason is the inactivity/stop record `orphanedQuestions.ts`
 * reads. The record stays until the user sends the next message in the
 * session or dismisses the notice.
 */
const causeSchema = z.enum(['memory-pressure', 'health-timeout', 'process-exited', 'unknown']);

export type RestartInterruptionCause = z.infer<typeof causeSchema>;

/**
 * The server's automatic resume of a priority session
 * (`packages/web/server/lib/session-interruption/auto-resume.js`).
 */
const resumeSchema = z.object({
  state: z.enum(['waiting', 'sent', 'manual']),
  at: z.number(),
  // `question-pending`: the cut-off tool was a question, which needs the user's answer.
  reason: z.enum(['memory-timeout', 'memory-unreadable', 'send-failed', 'question-pending']).optional().catch(undefined),
});

export type RestartResume = z.infer<typeof resumeSchema>;

/**
 * A server waits at most 10 minutes for memory (`RESUME_MEMORY_DEADLINE_MS`).
 * A `waiting` record older than that plus a margin belongs to a server that
 * stopped while it waited: nothing will send it, so it reads as manual.
 */
const ABANDONED_WAIT_MS = 15 * 60_000;

const restartSchema = z.object({
  openchamber: z.object({
    interruption: z.object({
      reason: z.literal('opencode-restart'),
      at: z.number(),
      // A cause a newer server adds reads as unknown here.
      cause: causeSchema.catch('unknown'),
      tool: z.object({
        name: z.string().min(1),
        input: z.string().nullish().transform((value) => value ?? undefined),
        callID: z.string().nullish().transform((value) => value ?? undefined),
      }).nullish().catch(null),
      resume: resumeSchema.nullish().catch(null),
    }),
  }),
});

export type RestartInterruption = {
  at: number;
  cause: RestartInterruptionCause;
  tool: { name: string; input?: string; callID?: string } | null;
  resume: RestartResume | null;
};

const cutTurnSchema = z.object({
  openchamber: z.object({
    restartCutTurn: z.object({
      messageID: z.string().min(1),
      at: z.number(),
      callID: z.string().nullish().catch(null),
      toolName: z.string().nullish().catch(null),
    }),
  }),
});

/**
 * The assistant message a managed OpenCode restart left open
 * (`metadata.openchamber.restartCutTurn`, written with the restart record by
 * `packages/web/server/lib/session-interruption/restart.js`). Unlike the
 * record, Dismiss and a sent message leave it in place: it is the
 * authoritative statement that the process running that turn died, so the
 * turn shows as interrupted and its question stays answerable. It counts only
 * while that message is the session's last conversation message.
 */
export type RestartCutTurn = { messageID: string; at: number; callID: string | null; toolName: string | null };

export function getRestartCutTurn(session: Session | null | undefined): RestartCutTurn | null {
  const cut = cutTurnSchema.safeParse(session?.metadata).data?.openchamber.restartCutTurn;
  return cut ? { messageID: cut.messageID, at: cut.at, callID: cut.callID ?? null, toolName: cut.toolName ?? null } : null;
}

export function getRestartInterruption(session: Session | null | undefined, now = Date.now()): RestartInterruption | null {
  const interruption = restartSchema.safeParse(session?.metadata).data?.openchamber.interruption;
  if (!interruption) return null;
  const resume = interruption.resume ?? null;
  return {
    at: interruption.at,
    cause: interruption.cause,
    tool: interruption.tool ?? null,
    resume: resume?.state === 'waiting' && now - resume.at > ABANDONED_WAIT_MS ? { ...resume, state: 'manual' } : resume,
  };
}

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });

/** The metadata without the restart record; any other interruption record stays. */
export function withoutRestartInterruption(metadata: Metadata): Metadata {
  if (!restartSchema.safeParse(metadata).success) return metadata;
  const namespace = { ...(openchamberSchema.safeParse(metadata).data?.openchamber ?? {}) };
  delete namespace.interruption;
  return { ...metadata, openchamber: namespace };
}
