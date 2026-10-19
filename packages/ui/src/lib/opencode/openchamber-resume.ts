/**
 * Messages OpenChamber sends to wake a session it saw cut off, as the
 * transcript sees them. Each is a synthetic message whose metadata names it
 * (`source: "openchamber-notice"`), so it renders as an OpenChamber row
 * rather than as something the user typed:
 *
 * - `restart-resume`: OpenChamber resumed the session after a managed
 *   OpenCode restart, on its own for a priority session (`trigger: "auto"`,
 *   `web/server/lib/session-interruption/auto-resume.js`) or from the
 *   notice's Continue (`trigger: "continue"`).
 * - `question-answer`: the user answered a question that a restart or
 *   OpenCode's inactivity eviction cut off (`answerOrphanedQuestion` in
 *   `@/sync/session-actions`).
 */

import { z } from "zod"

import type { Message } from "./model"

const OPENCHAMBER_RESUME_SOURCE = "openchamber-notice"

const toolSchema = z.object({ name: z.string().min(1), input: z.string().optional() })

const restartResumeSchema = z.object({
  source: z.literal(OPENCHAMBER_RESUME_SOURCE),
  kind: z.literal("restart-resume"),
  trigger: z.enum(["auto", "continue"]).catch("auto"),
  at: z.number(),
  cause: z.enum(["memory-pressure", "health-timeout", "process-exited", "unknown"]).catch("unknown"),
  tool: toolSchema.nullish().catch(null),
})

const questionAnswerSchema = z.object({
  source: z.literal(OPENCHAMBER_RESUME_SOURCE),
  kind: z.literal("question-answer"),
  cause: z.enum(["opencode-restart", "inactivity", "unknown"]).catch("unknown"),
  at: z.number(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).catch([]),
})

const resumeSchema = z.discriminatedUnion("kind", [restartResumeSchema, questionAnswerSchema])

export type OpenChamberResume = z.infer<typeof resumeSchema> & { text: string; sentAt: number }

/** The OpenChamber resume a message carries, or undefined for any other message. */
export function readOpenChamberResume(message: Message): OpenChamberResume | undefined {
  if (message.role !== "synthetic") return undefined
  const parsed = resumeSchema.safeParse(message.metadata ?? {})
  return parsed.success ? { ...parsed.data, text: message.text, sentAt: message.time.created } : undefined
}

/** Metadata of the answer to an interrupted question; agent-facing text travels beside it. */
export function questionAnswerMetadata(input: {
  cause: "opencode-restart" | "inactivity" | "unknown"
  at: number
  answers: ReadonlyArray<{ question: string; answer: string }>
}): z.input<typeof questionAnswerSchema> {
  return { source: OPENCHAMBER_RESUME_SOURCE, kind: "question-answer", cause: input.cause, at: input.at, answers: [...input.answers] }
}
