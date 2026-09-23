import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_PROMPT_LENGTH = 16_000;
export const MAX_MESSAGES = 100;

export const ERROR_DEFINITIONS = Object.freeze({
  UNAUTHORIZED: { statusCode: 401, message: 'Authentication required.' },
  PROJECT_DENIED: { statusCode: 403, message: 'Project access denied.' },
  ACTION_DENIED: { statusCode: 403, message: 'Action access denied.' },
  SESSION_NOT_FOUND: { statusCode: 404, message: 'Session not found.' },
  INVALID_REQUEST: { statusCode: 400, message: 'Invalid integration request.' },
  POLICY_UNAVAILABLE: { statusCode: 503, message: 'Integration policy unavailable.' },
});

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const label = z.string().min(1).max(200).refine((value) => value.trim().length > 0);
const selection = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/);
const prompt = z.string().min(1).max(MAX_PROMPT_LENGTH).refine((value) => value.trim().length > 0);
const model = z.string().min(3).max(401).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/);
const worktreeName = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const limit = z.number().int().min(1).max(MAX_MESSAGES).default(10);
const scope = { projectId: identifier };
const session = { ...scope, sessionId: identifier };
const dispatch = { model: model.optional(), agent: selection.optional(), variant: selection.optional() };

export const inputSchemas = Object.freeze({
  'projects.list': z.object({}).strict(),
  'session.list': z.object({ ...scope, limit, all: z.boolean().default(false) }).strict(),
  'session.create': z.object({
    ...scope, title: label.optional(), prompt: prompt.optional(), ...dispatch,
    worktree: worktreeName.optional(),
  }).strict(),
  'session.send': z.object({ ...session, prompt, ...dispatch }).strict(),
  // runExisting('fork') requires a nonempty prompt before it creates the fork.
  'session.fork': z.object({ ...session, messageId: identifier.optional(), prompt, ...dispatch }).strict(),
  'session.status': z.object(session).strict(),
  'session.messages': z.object({ ...session, limit, lastAssistant: z.boolean().optional() }).strict(),
});

export const ACTIONS = Object.freeze(Object.keys(inputSchemas));
const envelope = { schemaVersion: z.literal(SCHEMA_VERSION), requestId: z.string().uuid() };
export const requestSchema = z.discriminatedUnion('action', ACTIONS.map((action) => z.object({
  ...envelope, action: z.literal(action), input: inputSchemas[action],
}).strict()));

const sessionStatus = z.object({ type: z.enum(['idle', 'busy', 'retry', 'unknown']) }).strict();
const sessionSummary = z.object({ id: identifier, title: label.optional() }).strict();
const dispatchResult = z.object({ sessionId: identifier, promptDispatched: z.boolean() }).strict();
const message = z.object({
  id: identifier, role: z.enum(['user', 'assistant']), text: z.string().max(MAX_BODY_BYTES),
}).strict();
export const dataSchemas = Object.freeze({
  'projects.list': z.object({ projects: z.array(z.object({ id: identifier, label: label.optional() }).strict()).max(100) }).strict(),
  'session.list': z.object({ sessions: z.array(sessionSummary).max(100) }).strict(),
  'session.create': dispatchResult,
  'session.send': dispatchResult,
  'session.fork': dispatchResult.extend({ sourceSessionId: identifier }).strict(),
  'session.status': z.object({ sessionId: identifier, sessionStatus }).strict(),
  'session.messages': z.object({ sessionId: identifier, sessionStatus, messages: z.array(message).max(MAX_MESSAGES) }).strict(),
});

// Fixed public messages cannot leak upstream exceptions or supplied credentials.
const errorSchema = z.discriminatedUnion('code', Object.entries(ERROR_DEFINITIONS).map(([code, definition]) =>
  z.object({
    code: z.literal(code), message: z.literal(definition.message),
    partial: z.literal(true).optional(), sessionId: identifier.optional(),
  }).strict().refine((error) => (error.partial === true) === (error.sessionId !== undefined)),
));
export const responseSchema = z.discriminatedUnion('action', ACTIONS.map((action) => z.object({
  ...envelope, domainId: identifier, action: z.literal(action), ok: z.boolean(),
  data: dataSchemas[action].optional(), error: errorSchema.optional(),
}).strict().refine((response) => response.ok
  ? response.data !== undefined && response.error === undefined
  : response.error !== undefined && response.data === undefined,
)));

const invalid = () => ({
  success: false,
  error: { code: 'INVALID_REQUEST', message: ERROR_DEFINITIONS.INVALID_REQUEST.message },
});

// Raw JSON text is the boundary: count original UTF-8 bytes, including whitespace,
// before parsing. Never expose Zod issues, rejected keys, values, or exceptions.
const parse = (raw, schema) => {
  if (!z.string().safeParse(raw).success || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return invalid();
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? { success: true, data: result.data } : invalid();
  } catch {
    return invalid();
  }
};

const serialize = (value, schema) => {
  const result = schema.safeParse(value);
  if (!result.success) return invalid();
  const raw = JSON.stringify(result.data);
  return Buffer.byteLength(raw, 'utf8') <= MAX_BODY_BYTES
    ? { success: true, data: raw }
    : invalid();
};

export const parseRequest = (raw) => parse(raw, requestSchema);
export const parseResponse = (raw) => parse(raw, responseSchema);
export const serializeRequest = (value) => serialize(value, requestSchema);
export const serializeResponse = (value) => serialize(value, responseSchema);
