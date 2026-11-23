
import { z } from 'zod';
import { hasProperties, isString } from '../shared/guards.js';
import type { InterruptedTool, PendingQuestion, RestartDetails } from './contracts.js';

export const RESTART_REASON = 'opencode-restart';

const TOOL_INPUT_MAX_CHARS = 200;
export const RECENT_MESSAGE_LIMIT = 30;

const DESCRIPTIVE_INPUT_FIELDS = ['command', 'filePath', 'path', 'url', 'pattern', 'query', 'description'];

const textSchema = z.string().trim().min(1);
const inputSchema = z.union([textSchema, z.record(z.string(), z.unknown())]);

const toolPartSchema = <State extends z.ZodType>(state: State) => z.object({
  type: z.literal('tool'),
  id: textSchema.optional().catch(undefined),
  name: textSchema.catch('tool'),
  state,
});

const cutOffToolSchema = toolPartSchema(z.union([
  z.object({ status: z.enum(['running', 'streaming']), input: inputSchema.optional().catch(undefined) }),
  z.object({ status: z.literal('error'), error: z.object({ type: z.literal('aborted') }), input: inputSchema.optional().catch(undefined) }),
]));

const lastToolSchema = z.union([
  cutOffToolSchema,
  toolPartSchema(z.object({ status: z.literal('error'), input: inputSchema.optional().catch(undefined) })),
]);

const truncate = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TOOL_INPUT_MAX_CHARS ? `${flat.slice(0, TOOL_INPUT_MAX_CHARS - 1)}…` : flat;
};

const summarizeInput = (input: z.infer<typeof inputSchema> | undefined) => {
  if (isString(input)) return truncate(input);
  if (input === undefined) return null;
  const named = DESCRIPTIVE_INPUT_FIELDS.map((field) => textSchema.safeParse(input[field]).data).find(Boolean);
  const fallback = Object.values(input).map((value) => textSchema.safeParse(value).data).find(Boolean);
  const summary = named ?? fallback;
  return summary ? truncate(summary) : null;
};

export const findInterruptedTool = (records: readonly unknown[]): InterruptedTool | null => {
  let newest = true;
  for (const record of records) {
    if (!hasProperties(record)) continue;
    if (record.type === 'user') return null;
    if (record.type !== 'assistant' || !Array.isArray(record.content)) continue;
    for (let index = record.content.length - 1; index >= 0; index -= 1) {
      const endsTheTurn = newest && index === record.content.length - 1;
      const part = (endsTheTurn ? lastToolSchema : cutOffToolSchema).safeParse(record.content[index]);
      if (!part.success) continue;
      const input = summarizeInput(part.data.state.input);
      const tool: InterruptedTool = { name: part.data.name };
      if (input) tool.input = input;
      if (part.data.id) tool.callID = part.data.id;
      return tool;
    }
    newest = false;
  }
  return null;
};

const assistantIdSchema = z.object({ type: z.literal('assistant'), id: textSchema });

export const findCutAssistantMessageID = (records: readonly unknown[]) => {
  for (const record of records) {
    if (hasProperties(record) && record.type === 'user') return null;
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

export const findPendingQuestion = (records: readonly unknown[]): PendingQuestion | null => {
  for (const record of records) {
    if (!hasProperties(record)) continue;
    if (record.type === 'user') return null;
    if (record.type !== 'assistant') continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const part = questionToolSchema.safeParse(content[index]);
      if (!part.success) continue;
      const messageID = textSchema.safeParse(record.id);
      if (!messageID.success) return null;
      const [question] = part.data.state.input.questions;
      if (!question) continue;
      return { messageID: messageID.data, callID: part.data.id, title: truncate(question.question).slice(0, QUESTION_TITLE_MAX_CHARS) };
    }
    return null;
  }
  return null;
};

export const pendingQuestionRecord = (question: PendingQuestion | null, { cause, at }: { cause: string; at: number }) => (
  question ? { ...question, cause, at } : null
);

const QUESTION_TOOL = 'question';

const recordTool = (tool: InterruptedTool | null | undefined) => (tool
  ? { name: tool.name, input: tool.input ?? null, callID: tool.callID ?? null }
  : null);

type RestartPatch = { openchamber: {
  interruption: { reason: string; at: number; cause: string | null | undefined; tool: ReturnType<typeof recordTool>; resume: { state: string; at: number; reason: string } | null } | null;
  restartCutTurn: { messageID: string; at: number; callID: string | null; toolName: string | null } | null;
  pendingQuestion: ReturnType<typeof pendingQuestionRecord>;
} }

export const restartInterruptionPatch = ({ at, cause, tool, messageID = null, question = null }: RestartDetails & {
  readonly messageID?: string | null;
  readonly question?: PendingQuestion | null;
}): RestartPatch => ({
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

const presentFields = (fields: Readonly<Record<string, string | null | undefined>>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value));

export const restartInterruptedNotification = (sessions: readonly { readonly sessionId: string; readonly directory?: string | null; readonly title?: string | null }[]) => {
  const multiple = sessions.length > 1;
  const [first] = sessions;
  if (!first) throw new TypeError("Cannot read properties of undefined (reading 'sessionId')");
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
