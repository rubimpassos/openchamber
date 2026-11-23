import { z } from 'zod';

const PAGE_SIZE = 100;
const countSchema = z.number().finite().nonnegative();
const tokensSchema = z.object({
  input: countSchema,
  output: countSchema,
  reasoning: countSchema,
  cache: z.object({ read: countSchema, write: countSchema }),
});
const messageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'assistant', 'compaction', 'idle']),
  time: z.object({ created: countSchema, completed: countSchema.optional() }),
}).passthrough();
const assistantSchema = messageSchema.extend({ tokens: tokensSchema });
const pageSchema = z.object({
  data: z.array(messageSchema).max(PAGE_SIZE),
  cursor: z.object({ next: z.string().min(1).nullable().optional(), previous: z.string().min(1).nullable().optional() }),
});

/** Completed assistant-step usage since activation, or null for an incomplete read. */
export type TokenReaderOptions = {
  readonly buildOpenCodeUrl: (pathname: string, search: string) => string;
  readonly getOpenCodeAuthHeaders: () => Readonly<Record<string, string>>;
  readonly fetchImpl?: (url: URL, options: { readonly headers: Headers; readonly signal: AbortSignal }) => Promise<Response>;
};
export const createTokenSnapshotReader = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl = fetch }: TokenReaderOptions) =>
  async (sessionId: string, directory: string | null, { since = 0 }: { readonly since?: number } = {}) => {
    if (!Number.isFinite(since) || since < 0) return null;
    const signal = AbortSignal.timeout(10_000);
    const cursors = new Set<string>();
    const messages = new Set<string>();
    let cursor: string | undefined;
    let total = 0;
    try {
      while (true) {
        const url = new URL(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/message`, ''));
        url.searchParams.set('limit', String(PAGE_SIZE));
        if (cursor) url.searchParams.set('cursor', cursor);
        const headers = new Headers({ Accept: 'application/json', ...getOpenCodeAuthHeaders() });
        if (directory) headers.set('x-opencode-directory', encodeURIComponent(directory));
        const response = await fetchImpl(url, {
          headers,
          signal,
        });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const page = pageSchema.safeParse(body);
        if (!page.success) return null;
        for (const message of page.data.data) {
          // Pages are newest first. Compaction leaves earlier usage records readable.
          if (message.time.created < since) return total;
          if (messages.has(message.id)) return null;
          messages.add(message.id);
          if (message.type !== 'assistant' || message.time.completed === undefined) continue;
          const assistant = assistantSchema.safeParse(message);
          if (!assistant.success) return null;
          const { input, output, reasoning, cache } = assistant.data.tokens;
          total += input + output + reasoning + cache.read + cache.write;
          if (!Number.isFinite(total)) return null;
        }
        // The pinned server emits a next cursor even on its final nonempty page.
        if (page.data.data.length < PAGE_SIZE) return total;
        const next = page.data.cursor.next;
        if (!next || cursors.has(next)) return null;
        cursors.add(next);
        cursor = next;
      }
    } catch {
      // Transport, timeout and JSON failures must never publish a partial total.
      return null;
    }
  };
