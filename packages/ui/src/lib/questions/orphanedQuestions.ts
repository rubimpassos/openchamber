import { z } from 'zod';
import type { Message, Part, QuestionInfo, QuestionOption, QuestionRequest, Session } from '@/lib/opencode/model';

/**
 * Orphaned question detection.
 *
 * When the OpenCode server restarts (or is hard-killed) while a `question`
 * tool call is waiting for the user, the pending question only ever lived in
 * server memory and is destroyed (upstream anomalyco/opencode#36347). The
 * message history still contains the question tool part stuck in
 * pending/running state, but `form.list()` no longer returns it, so the
 * regular form dock never renders and the session appears stuck.
 *
 * This module synthesizes an answerable `QuestionRequest` from that stale
 * tool part so the user can still answer. Submission goes through
 * `answerOrphanedQuestion()` in `sync/session-actions.ts`, which re-checks
 * the server authoritatively and falls back to sending the answers as a new
 * user message.
 *
 * On OpenCode 2.x the part usually does not stay pending: the interrupted
 * step settles it as `error` ("Tool execution interrupted"). The most common
 * cause is OpenCode's location eviction, which interrupts every execution in
 * a directory after 60 minutes without session events, and a question waiting
 * for an answer produces none. An errored question counts as orphaned only
 * when the session's last interruption was that eviction
 * (`wasInterruptedByInactivity`); a Stop pressed by the user errors the part
 * the same way and must not bring the question back.
 *
 * Scope: only the current session's last assistant message is considered (a
 * stale question from an older turn the user already moved past must not
 * resurrect), and only while the session is idle — callers gate on session
 * status because a live waiting question keeps the session busy.
 */

export const ORPHANED_QUESTION_ID_PREFIX = 'orphaned:';

export function isOrphanedQuestionId(id: string): boolean {
  return id.startsWith(ORPHANED_QUESTION_ID_PREFIX);
}

type MessageRecord = { info: Message; parts: Part[] };

type QuestionToolPart = Extract<Part, { type: 'tool' }>;

const isQuestionToolPart = (part: Part): part is QuestionToolPart =>
  part.type === 'tool' && part.tool === 'question';

/**
 * Rows OpenCode 2.x records after a turn that carry no content: the turn's
 * idle marker and the agent/model/location switches. The question still
 * belongs to the last turn when one of these follows it.
 */
const TURN_MARKER_ROLES = new Set<Message['role']>(['idle', 'agent-switched', 'model-switched', 'location-switched']);

/** Index of the last message with content, or -1. */
export function findLastContentMessageIndex(messages: ReadonlyArray<Message>): number {
  let index = messages.length - 1;
  while (index >= 0 && TURN_MARKER_ROLES.has(messages[index].role)) index -= 1;
  return index;
}

/**
 * Written by the server's session-interruption runtime
 * (`packages/web/server/lib/session-interruption/runtime.js`) when OpenCode
 * interrupts a turn for any reason but a shutdown.
 */
const interruptionSchema = z.object({
  openchamber: z.object({
    interruption: z.object({ reason: z.string(), at: z.number() }),
  }),
});

/**
 * Whether the session's latest turn ended because OpenCode evicted its
 * location for inactivity. A record older than the session's last idle time
 * belongs to an earlier turn and does not count.
 */
export function wasInterruptedByInactivity(session: Session | null | undefined): boolean {
  if (!session) return false;
  const interruption = interruptionSchema.safeParse(session.metadata).data?.openchamber.interruption;
  if (!interruption || interruption.reason !== 'inactivity') return false;
  return interruption.at >= (session.time?.idle ?? 0);
}

const parseQuestionOption = (value: unknown): QuestionOption | null => {
  if (!value || typeof value !== 'object') return null;
  const label = (value as { label?: unknown }).label;
  if (typeof label !== 'string' || label.length === 0) return null;
  const description = (value as { description?: unknown }).description;
  return { label, description: typeof description === 'string' ? description : '' };
};

const parseQuestionInfo = (value: unknown): QuestionInfo | null => {
  if (!value || typeof value !== 'object') return null;
  const question = (value as { question?: unknown }).question;
  if (typeof question !== 'string' || question.trim().length === 0) return null;
  const header = (value as { header?: unknown }).header;
  const rawOptions = (value as { options?: unknown }).options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.map(parseQuestionOption).filter((option): option is QuestionOption => option !== null)
    : [];
  const multiple = (value as { multiple?: unknown }).multiple;
  return {
    question,
    header: typeof header === 'string' ? header : '',
    options,
    ...(typeof multiple === 'boolean' ? { multiple } : {}),
  };
};

const parseQuestionsFromToolInput = (input: unknown): QuestionInfo[] => {
  if (!input || typeof input !== 'object') return [];
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.map(parseQuestionInfo).filter((question): question is QuestionInfo => question !== null);
};

/**
 * Collect answerable question requests for question tool calls that are stuck
 * pending/running in the last message of the session, or errored by an
 * inactivity interruption, and are no longer pending server-side
 * (`liveQuestions` is the authoritative pending set for the session subtree).
 *
 * Callers must additionally gate on the session being idle: while a question
 * is genuinely waiting, the session run is active and the live form dock
 * renders through the sync store instead.
 */
export function collectOrphanedQuestionRequests(
  sessionId: string,
  records: MessageRecord[],
  liveQuestions: QuestionRequest[],
  interruptedByInactivity: boolean,
): QuestionRequest[] {
  if (!sessionId || records.length === 0) return [];

  const lastRecord = records[findLastContentMessageIndex(records.map((record) => record.info))];
  if (!lastRecord || lastRecord.info.role !== 'assistant' || lastRecord.info.sessionID !== sessionId) return [];

  const liveCallIds = new Set<string>();
  for (const question of liveQuestions) {
    if (question.tool?.callID) liveCallIds.add(question.tool.callID);
  }

  const orphaned: QuestionRequest[] = [];
  for (const part of lastRecord.parts) {
    if (!isQuestionToolPart(part)) continue;
    const stranded = part.state.status === 'pending' || part.state.status === 'running';
    const interrupted = part.state.status === 'error' && interruptedByInactivity;
    if (!stranded && !interrupted) continue;
    if (liveCallIds.has(part.callID)) continue;
    if (isOrphanedQuestionDismissed(part.callID)) continue;

    const input = 'input' in part.state ? part.state.input : undefined;
    const questions = parseQuestionsFromToolInput(input);
    if (questions.length === 0) continue;

    orphaned.push({
      id: `${ORPHANED_QUESTION_ID_PREFIX}${part.callID}`,
      sessionID: sessionId,
      questions,
      tool: { messageID: part.messageID, callID: part.callID },
    });
  }

  return orphaned;
}

/**
 * Build the user message that carries the answers back to the agent when the
 * original question request no longer exists server-side. Mirrors the phrasing
 * of the question tool's own result ("User has answered your questions: ...")
 * so the model treats it as the missing answer to its interrupted tool call.
 * Agent-facing content — intentionally not localized.
 */
export function buildOrphanedAnswerMessage(question: QuestionRequest, answers: string[][]): string {
  const pairs: string[] = [];
  question.questions.forEach((info, index) => {
    const answer = (answers[index] ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    if (answer.length === 0) return;
    pairs.push(`"${info.question}"="${answer.join(', ')}"`);
  });
  const answered = pairs.length > 0 ? pairs.join(', ') : '(no answer provided)';
  return `Your previous question was interrupted before I could answer (the session was restarted). Here are my answers: ${answered}. Please continue from where you left off.`;
}

// ---------------------------------------------------------------------------
// Dismissal persistence
// ---------------------------------------------------------------------------
// Dismissing an orphaned question has no server side effect (there is nothing
// pending to reject), so remember dismissed tool call IDs locally to keep the
// card hidden across reloads.

const DISMISSED_STORAGE_KEY = 'oc.orphanedQuestionDismissals';
const DISMISSED_LIMIT = 100;

function readDismissedCallIds(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function isOrphanedQuestionDismissed(callId: string): boolean {
  return readDismissedCallIds().includes(callId);
}

export function markOrphanedQuestionDismissed(callId: string): void {
  if (!callId) return;
  try {
    const next = [...readDismissedCallIds().filter((value) => value !== callId), callId].slice(-DISMISSED_LIMIT);
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable/quota exceeded — dismissal stays session-local.
  }
}
