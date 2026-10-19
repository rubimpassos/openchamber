/**
 * The record a managed OpenCode restart leaves on each session whose turn it
 * killed: `metadata.openchamber.interruption` with `reason: 'opencode-restart'`,
 * `at`, `cause` and the tool that was running. The UI shows it above the
 * composer until the user sends the next message there or dismisses it. The
 * UI parser is `packages/ui/src/lib/sessionRestartInterruption.ts`.
 */

import { z } from 'zod';

export const RESTART_REASON = 'opencode-restart';

const TOOL_INPUT_MAX_CHARS = 200;
/** Records read back from the newest; a turn's last tool call sits near the end. */
export const RECENT_MESSAGE_LIMIT = 30;

// Fields that say what a tool call was doing, in the order they describe it best.
const DESCRIPTIVE_INPUT_FIELDS = ['command', 'filePath', 'path', 'url', 'pattern', 'query', 'description'];

const textSchema = z.string().trim().min(1);
// A running call's input is a record; a streaming call's is the raw JSON text.
const inputSchema = z.union([textSchema, z.record(z.string(), z.unknown())]);

const toolPartSchema = (state) => z.object({
  type: z.literal('tool'),
  id: textSchema.optional().catch(undefined),
  name: textSchema.catch('tool'),
  state,
});

/**
 * A tool call the restart killed: still marked running by the old process,
 * or aborted by the new one when it settled the turn.
 */
const cutOffToolSchema = toolPartSchema(z.union([
  z.object({ status: z.enum(['running', 'streaming']), input: inputSchema.optional().catch(undefined) }),
  z.object({ status: z.literal('error'), error: z.object({ type: z.literal('aborted') }), input: inputSchema.optional().catch(undefined) }),
]));

/**
 * The last part of the turn may also be a tool with any error. A graceful stop
 * settles a running command with its own error ("Command cancelled") before
 * the process exits; nothing came after it in a turn the session was still
 * running, so the restart cut it off.
 */
const lastToolSchema = z.union([
  cutOffToolSchema,
  toolPartSchema(z.object({ status: z.literal('error'), input: inputSchema.optional().catch(undefined) })),
]);

const truncate = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_INPUT_MAX_CHARS ? `${flat.slice(0, TOOL_INPUT_MAX_CHARS - 1)}…` : flat;
};

const summarizeInput = (input) => {
  const text = textSchema.safeParse(input);
  if (text.success) return truncate(text.data);
  if (input === undefined) return null;
  const named = DESCRIPTIVE_INPUT_FIELDS.map((field) => textSchema.safeParse(input[field]).data).find(Boolean);
  const fallback = Object.values(input).map((value) => textSchema.safeParse(value).data).find(Boolean);
  const summary = named ?? fallback;
  return summary ? truncate(summary) : null;
};

/**
 * The last tool call of the newest turn that the restart cut off, from a page
 * of message records newest first: `{ name, input?, callID? }`, or null when
 * the turn had none. The user's message opens the turn, so the scan stops there.
 */
export const findInterruptedTool = (records) => {
  let newest = true;
  for (const record of records) {
    if (record?.type === 'user') return null;
    if (record?.type !== 'assistant' || !Array.isArray(record.content)) continue;
    for (let index = record.content.length - 1; index >= 0; index -= 1) {
      const endsTheTurn = newest && index === record.content.length - 1;
      const part = (endsTheTurn ? lastToolSchema : cutOffToolSchema).safeParse(record.content[index]);
      if (!part.success) continue;
      const tool = { name: part.data.name };
      const input = summarizeInput(part.data.state.input);
      if (input) tool.input = input;
      if (part.data.id) tool.callID = part.data.id;
      return tool;
    }
    newest = false;
  }
  return null;
};

const assistantIdSchema = z.object({ type: z.literal('assistant'), id: textSchema });

/**
 * The id of the newest assistant message of the newest turn, the one the
 * restart cut off: still open after a hard kill, or completed by OpenCode
 * itself when it stopped gracefully. Null when the turn has none.
 */
export const findCutAssistantMessageID = (records) => {
  for (const record of records) {
    if (record?.type === 'user') return null;
    const message = assistantIdSchema.safeParse(record);
    if (message.success) return message.data.id;
  }
  return null;
};

const QUESTION_TITLE_MAX_CHARS = 200;

const questionToolSchema = z.object({
  type: z.literal('tool'),
  id: textSchema,
  name: z.literal('question'),
  state: z.object({
    status: z.enum(['running', 'streaming', 'error']),
    input: z.object({ questions: z.array(z.object({ question: textSchema })).min(1) }),
  }),
});

/**
 * The question the newest assistant message of the newest turn was asking
 * when it was cut off, if the user can still answer it: its message, call and
 * first question. The UI shows such a question again (`orphanedQuestions.ts`)
 * and every "waiting for you" surface reads it from
 * `metadata.openchamber.pendingQuestion`, which this feeds.
 */
export const findPendingQuestion = (records) => {
  for (const record of records) {
    if (record?.type === 'user') return null;
    if (record?.type !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const part = questionToolSchema.safeParse(content[index]);
      if (!part.success) continue;
      const messageID = textSchema.safeParse(record.id);
      if (!messageID.success) return null;
      return { messageID: messageID.data, callID: part.data.id, title: truncate(part.data.state.input.questions[0].question).slice(0, QUESTION_TITLE_MAX_CHARS) };
    }
    return null;
  }
  return null;
};

/** `metadata.openchamber.pendingQuestion`, or null to clear an older one. */
export const pendingQuestionRecord = (question, { cause, at }) => (
  question ? { ...question, cause, at } : null
);

/** A question the restart cut off waits for an answer; resuming would go on without it. */
const QUESTION_TOOL = 'question';

/**
 * The restart record, plus `restartCutTurn`: which message the restart cut
 * off, for the UI to show that turn as interrupted (and its question as
 * answerable) after the notice is gone. Dismiss and a sent message leave
 * `restartCutTurn` alone; the next restart replaces it, and it stops counting
 * once that message is no longer the session's last.
 */
/**
 * The store merges patches (RFC 7386): a field left out keeps the previous
 * restart's value. Every field of the tool is written, null when absent, so a
 * newer record never inherits an older command.
 */
const recordTool = (tool) => (tool
  ? { name: tool.name, input: tool.input ?? null, callID: tool.callID ?? null }
  : null);

export const restartInterruptionPatch = ({ at, cause, tool, messageID = null, question = null }) => ({
  openchamber: {
    interruption: {
      reason: RESTART_REASON,
      at,
      cause,
      tool: recordTool(tool),
      resume: tool?.name === QUESTION_TOOL ? { state: 'manual', at, reason: 'question-pending' } : null,
    },
    restartCutTurn: messageID
      ? { messageID, at, callID: tool?.callID ?? null, toolName: tool?.name ?? null }
      : null,
    pendingQuestion: pendingQuestionRecord(question, { cause: RESTART_REASON, at }),
  },
});

/** Only the fields a session record actually has. */
const presentFields = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value));

/**
 * The `opencode-restart-interrupted` UI notification. `sessions` lists every
 * interrupted session so the toast can open each; `sessionId` and `directory`
 * name the first one for native notifications and clients that read only
 * those. Title and body are the native notification's text; the shared UI
 * renders its own translated toast.
 */
export const restartInterruptedNotification = (sessions) => {
  const multiple = sessions.length > 1;
  const [first] = sessions;
  return {
    title: multiple ? 'Chats interrupted' : 'Chat interrupted',
    body: multiple
      ? `OpenCode restarted during ${sessions.length} running responses. Open each chat to continue.`
      : 'OpenCode restarted during a running response. Open the chat to continue.',
    tag: 'opencode-restart-interrupted',
    kind: 'opencode-restart-interrupted',
    ...presentFields({ sessionId: first.sessionId, directory: first.directory }),
    sessions: sessions.map(({ sessionId, directory, title }) => presentFields({ sessionId, directory, title })),
  };
};
