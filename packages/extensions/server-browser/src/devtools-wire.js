import { z } from 'zod';

const recordSchema = z.record(z.string(), z.json());
const identitySchema = z.union([z.string().min(1).max(512), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]);
const commandSchema = z.object({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z.string(),
  params: recordSchema.optional(),
  sessionId: z.string().min(1).optional(),
}).strict();
const eventSchema = z.object({
  id: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  method: z.string().optional(),
  params: recordSchema.optional(),
  result: recordSchema.optional(),
  error: recordSchema.optional(),
  sessionId: z.string().optional(),
}).passthrough();

export const readProtocolIdentity = (value) => {
  const parsed = identitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const readMessage = (raw, schema) => {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

export const readDevToolsCommand = (raw) => readMessage(raw, commandSchema);
export const readDevToolsEvent = (raw) => readMessage(raw, eventSchema);
export const withProtocolSession = (message, sessionId) => sessionId ? { ...message, sessionId } : message;
