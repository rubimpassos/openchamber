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

/** A tool call the restart killed: aborted by the new process, or still marked running by the old one. */
const cutOffToolSchema = z.object({
  type: z.literal('tool'),
  name: textSchema.catch('tool'),
  state: z.union([
    z.object({ status: z.enum(['running', 'streaming']), input: inputSchema.optional().catch(undefined) }),
    z.object({ status: z.literal('error'), error: z.object({ type: z.literal('aborted') }), input: inputSchema.optional().catch(undefined) }),
  ]),
});

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
 * of message records newest first: `{ name, input }`, or null when the turn
 * had none. The user's message opens the turn, so the scan stops there.
 */
export const findInterruptedTool = (records) => {
  for (const record of records) {
    if (record?.type === 'user') return null;
    if (record?.type !== 'assistant' || !Array.isArray(record.content)) continue;
    for (let index = record.content.length - 1; index >= 0; index -= 1) {
      const part = cutOffToolSchema.safeParse(record.content[index]);
      if (!part.success) continue;
      const tool = { name: part.data.name };
      const input = summarizeInput(part.data.state.input);
      if (input) tool.input = input;
      return tool;
    }
  }
  return null;
};

export const restartInterruptionPatch = ({ at, cause, tool }) => ({
  openchamber: { interruption: { reason: RESTART_REASON, at, cause, tool: tool ?? null, resume: null } },
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
