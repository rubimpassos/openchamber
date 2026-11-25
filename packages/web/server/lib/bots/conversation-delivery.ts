import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { artifactBindingSchema, BotArtifactError, sameArtifactBinding } from './artifacts-contract.js';
import type { BotArtifactBinding } from './artifacts-contract.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import { controlErrorFields } from '../openchamber-control/error.js';

export const conversationDeliverySchema = z.object({
  id: z.string().min(1).max(200), text: z.string().max(200_000), resume: z.boolean().optional(),
}).catchall(z.json());
const recordSchema = z.object({ binding: artifactBindingSchema, body: conversationDeliverySchema,
  delivered: z.boolean() }).strict();
type Options = {
  readonly dataDir: string;
  readonly resolveSession: (sessionId: string) => Promise<BotArtifactBinding | null>;
  readonly updateMetadata: (sessionId: string, patch: SessionMetadata) => Promise<void>;
};
type DeliveryDisposition =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'delivered'; readonly id: string }
  | { readonly kind: 'record' };

export function createBotConversationDelivery({ dataDir, resolveSession, updateMetadata }: Options) {
  const records = createBotAdapterState({ dataDir, name: 'conversation-delivery', schema: recordSchema });
  const pendingIndex = createBotAdapterState({ dataDir, name: 'conversation-delivery-pending',
    schema: z.object({ ids: z.array(z.string().min(1).max(200)).max(4096) }).strict() });
  const announced = new Set<string>();
  const keyFor = (sessionId: string, id: string) => ({ sessionId, id });
  const index = (sessionId: string, id: string, include: boolean) => pendingIndex.own(sessionId, async () => {
    const previous = (await pendingIndex.read(sessionId))?.ids ?? [];
    if (previous.includes(id) === include) return;
    await pendingIndex.write(sessionId, { ids: include ? [...previous, id] : previous.filter((entry) => entry !== id) });
  });
  const request = async (sessionId: string, raw: unknown): Promise<DeliveryDisposition> => {
    const binding = await resolveSession(sessionId);
    if (!binding || binding.producer.role !== 'conversation') return { kind: 'ordinary' };
    const body = conversationDeliverySchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_TOO_LARGE', 413);
    if (body.resume === false) return { kind: 'record' };
    const key = keyFor(sessionId, body.id);
    const delivered = await records.own(key, async () => {
      const previous = await records.read(key);
      if (previous && (!sameArtifactBinding(previous.binding, binding) || JSON.stringify(previous.body) !== JSON.stringify(body))) {
        throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_CHANGED');
      }
      if (!previous) await records.write(key, { binding, body, delivered: false });
      await index(sessionId, body.id, !previous?.delivered);
      return previous?.delivered ?? false;
    });
    if (delivered) return { kind: 'delivered', id: body.id };
    const announcement = JSON.stringify(key);
    if (!announced.has(announcement)) {
      await updateMetadata(sessionId, { openchamber: { botConversationDeliveryPending: body.id } });
      announced.add(announcement);
    }
    throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_PENDING', 503);
  };
  const pending = async (binding: BotArtifactBinding) => {
    const result: z.output<typeof conversationDeliverySchema>[] = [];
    for (const id of (await pendingIndex.read(binding.sessionId))?.ids ?? []) {
      const entry = await records.read(keyFor(binding.sessionId, id));
      if (!entry || !sameArtifactBinding(entry.binding, binding)) throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_REQUIRED', 403);
      if (!entry.delivered) result.push(entry.body);
    }
    return result;
  };
  const settle = async (binding: BotArtifactBinding, id: string) => {
    const key = keyFor(binding.sessionId, id);
    return records.own(key, async () => {
      const record = await records.read(key);
      if (!record || !sameArtifactBinding(record.binding, binding)) throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_REQUIRED', 403);
      if (!record.delivered) await records.write(key, { ...record, delivered: true });
      await index(binding.sessionId, id, false);
      return { settled: true as const };
    });
  };
  const confirmNonResuming = async (sessionId: string, raw: unknown) => {
    const body = conversationDeliverySchema.safeParse(raw);
    if (!body.success || body.data.resume !== false) return;
    const recorded = await records.read(keyFor(sessionId, body.data.id));
    if (!recorded) return;
    const { resume: _requestedResume, ...requested } = recorded.body;
    const { resume: _confirmedResume, ...confirmed } = body.data;
    if (JSON.stringify(requested) !== JSON.stringify(confirmed)) {
      throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_CHANGED');
    }
    await settle(recorded.binding, body.data.id);
  };
  return { request, pending, settle, confirmNonResuming };
}

export const botConversationDeliveryFetch = (getDelivery: () => ReturnType<typeof createBotConversationDelivery> | null): typeof fetch =>
  async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const sessionId = /^\/api\/session\/([^/]+)\/synthetic$/.exec(url.pathname)?.[1];
    if (sessionId && init?.method === 'POST') {
      const body = z.string().parse(init.body);
      const delivery = getDelivery();
      if (!delivery) throw new BotArtifactError('BOT_EXECUTION_NOT_READY', 503);
      const raw: unknown = JSON.parse(body);
      let disposition: DeliveryDisposition;
      try {
        disposition = await delivery.request(decodeURIComponent(sessionId), raw);
      } catch (error) {
        if (controlErrorFields(error)?._tag !== 'SessionNotFoundError') throw error;
        disposition = { kind: 'ordinary' };
      }
      switch (disposition.kind) {
        case 'ordinary': return fetch(input, init);
        case 'delivered': return Response.json({ data: { id: disposition.id } });
        case 'record': {
          const response = await fetch(input, init);
          if (response.ok || response.status === 404 || response.status === 409) await delivery.confirmNonResuming(decodeURIComponent(sessionId), raw);
          return response;
        }
        default: return assertNever(disposition);
      }
    }
    return fetch(input, init);
  };
function assertNever(value: never): never { throw new TypeError(`Unknown Bot conversation delivery: ${String(value)}`); }
