import express from 'express';
import { z } from 'zod';
import type { Router } from '../shared/http-contracts.js';
import type { createBotArtifactCapture } from '../bots/artifacts-capture.js';
import { BotArtifactError, sameArtifactBinding } from '../bots/artifacts-contract.js';
import type { BotArtifactBinding } from '../bots/artifacts-contract.js';
import type { BotArtifactManifest } from '../bots/artifacts-contract.js';
import type { RenderedPageProjection } from '../openchamber-control/page-projection.js';
import type { createBotConversationDelivery } from '../bots/conversation-delivery.js';
import type { JsonValue } from '../shared/json-values.js';
import {
  BOT_ARTIFACT_AGENT_ROUTE, BOT_ARTIFACT_SPACE_ROUTE, BOT_ARTIFACT_REPLY_BYTES, BOT_ARTIFACT_TIMEOUT_MS,
  artifactPullInputSchema, artifactPullReplySchema, artifactChunkInputSchema, artifactChunkReplySchema,
  artifactPageInputSchema, artifactPageReplySchema,
  artifactDeliveryReplySchema, artifactDeliverySettleSchema,
  artifactProducerInputSchema,
} from './bot-artifact-service-contract.js';
import type { BotArtifactTransport } from './bot-artifact-service-contract.js';
import { readBoundedBody } from './agent-upstream.js';
import type { AgentUpstream } from './agent-upstream.js';
import { botBoundaryError } from './bot-service-contract.js';

type ServiceOptions = {
  readonly capture: ReturnType<typeof createBotArtifactCapture>;
  readonly resolveBinding: (sessionId: string) => Promise<BotArtifactBinding | null>;
  readonly readPage?: (manifest: BotArtifactManifest) => Promise<RenderedPageProjection | null>;
  readonly delivery?: ReturnType<typeof createBotConversationDelivery>;
  readonly stopProducer?: (binding: BotArtifactBinding) => Promise<void>;
};
export function createBotArtifactService({ capture, resolveBinding, readPage, delivery, stopProducer }: ServiceOptions) {
  const authorize = async (binding: BotArtifactBinding) => {
    const recorded = await resolveBinding(binding.sessionId);
    if (!recorded || !sameArtifactBinding(recorded, binding)) throw new BotArtifactError('BOT_ARTIFACT_BINDING_REQUIRED', 403);
  };
  return {
    async drain(raw: unknown) {
      const { binding } = artifactProducerInputSchema.parse(raw);
      await authorize(binding);
      await capture.flush(binding.sessionId);
      return { drained: true as const };
    },
    async quiesce(raw: unknown) {
      const { binding } = artifactProducerInputSchema.parse(raw);
      await authorize(binding);
      if (binding.producer.role !== 'stage' || !stopProducer) throw new BotArtifactError('BOT_ARTIFACT_PRODUCER_STOP_REQUIRED', 403);
      await stopProducer(binding);
      await capture.flush(binding.sessionId);
      return { stopped: true as const };
    },
    async deliveries(raw: unknown) {
      const { binding } = artifactPullInputSchema.parse(raw);
      await authorize(binding);
      const entries = delivery ? await delivery.pending(binding) : [];
      return artifactDeliveryReplySchema.parse({ entries: entries.slice(0, 1), nextOffset: entries.length > 1 ? 0 : null });
    },
    async settleDelivery(raw: unknown) {
      const { binding, id } = artifactDeliverySettleSchema.parse(raw);
      await authorize(binding);
      if (!delivery) throw new BotArtifactError('BOT_CONVERSATION_DELIVERY_REQUIRED', 503);
      return delivery.settle(binding, id);
    },
    async page(raw: unknown) {
      const { binding, id } = artifactPageInputSchema.parse(raw);
      await authorize(binding);
      const manifest = await capture.manifest(binding, id);
      return artifactPageReplySchema.parse({ page: readPage ? await readPage(manifest) : null });
    },
    async pull(raw: unknown) {
      const input = artifactPullInputSchema.parse(raw);
      await authorize(input.binding);
      return artifactPullReplySchema.parse(await capture.list(input.binding, { offset: input.offset, limit: 1 }));
    },
    async chunk(raw: unknown) {
      const input = artifactChunkInputSchema.parse(raw);
      await authorize(input.binding);
      return artifactChunkReplySchema.parse(await capture.chunk(input.binding, {
        id: input.id, callId: input.callId, sessionId: input.binding.sessionId, offset: input.offset,
      }));
    },
  };
}

export function createBotArtifactTransport({ request }: {
  readonly request: (operation: 'pull' | 'chunk' | 'page' | 'deliveries' | 'settle-delivery' | 'quiesce' | 'drain', body: string, signal: AbortSignal) => Promise<JsonValue>;
}): BotArtifactTransport {
  return {
    drain: async (input, signal) => z.object({ drained: z.literal(true) }).strict().parse(await request('drain', JSON.stringify(artifactProducerInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    quiesce: async (input, signal) => z.object({ stopped: z.literal(true) }).strict().parse(await request('quiesce', JSON.stringify(artifactProducerInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    deliveries: async (input, signal) => artifactDeliveryReplySchema.parse(await request('deliveries', JSON.stringify(artifactPullInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    settleDelivery: async (input, signal) => z.object({ settled: z.literal(true) }).strict().parse(await request('settle-delivery', JSON.stringify(artifactDeliverySettleSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    page: async (input, signal) => artifactPageReplySchema.parse(await request('page', JSON.stringify(artifactPageInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    pull: async (input, signal) => artifactPullReplySchema.parse(await request('pull', JSON.stringify(artifactPullInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
    chunk: async (input, signal) => artifactChunkReplySchema.parse(await request('chunk', JSON.stringify(artifactChunkInputSchema.parse(input)),
      signal ? AbortSignal.any([signal, AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS)]) : AbortSignal.timeout(BOT_ARTIFACT_TIMEOUT_MS))),
  };
}

export function createAgentBotArtifactTransport(upstream: Pick<AgentUpstream, 'request'>) {
  return createBotArtifactTransport({ request: async (operation, body, signal) => {
    const response = await upstream.request({ path: `${BOT_ARTIFACT_AGENT_ROUTE}/${operation}`, method: 'POST', body, signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' } });
    const value = z.json().parse(JSON.parse(await readBoundedBody(response, BOT_ARTIFACT_REPLY_BYTES)));
    if (!response.complete || response.statusCode !== 200) throw botBoundaryError('BOT_ARTIFACT_TRANSFER_FAILED');
    return value;
  } });
}

export function registerBotArtifactServiceRoutes(app: Router, options: {
  readonly service: ReturnType<typeof createBotArtifactService>;
  readonly placement: 'agent' | 'space';
  readonly isAllowed: () => boolean;
}) {
  const root = options.placement === 'agent' ? BOT_ARTIFACT_AGENT_ROUTE : BOT_ARTIFACT_SPACE_ROUTE;
  app.post(`${root}/:operation`, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!options.isAllowed()) return res.status(403).json({ code: 'BOT_ARTIFACT_EXECUTOR_REQUIRED' });
    if (new URL(req.originalUrl, 'http://local').search) return res.status(400).json({ code: 'BOT_ARTIFACT_QUERY_INVALID' });
    express.json({ limit: 16 * 1024 })(req, res, (error) => error ? res.status(400).json({ code: 'BOT_ARTIFACT_INPUT_INVALID' }) : next());
  }, async (req, res) => {
    try {
      let result: unknown;
      switch (req.params.operation) {
        case 'pull': result = await options.service.pull(req.body); break;
        case 'chunk': result = await options.service.chunk(req.body); break;
        case 'page': result = await options.service.page(req.body); break;
        case 'deliveries': result = await options.service.deliveries(req.body); break;
        case 'settle-delivery': result = await options.service.settleDelivery(req.body); break;
        case 'quiesce': result = await options.service.quiesce(req.body); break;
        case 'drain': result = await options.service.drain(req.body); break;
        default: return res.status(400).json({ code: 'BOT_ARTIFACT_OPERATION_INVALID' });
      }
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > BOT_ARTIFACT_REPLY_BYTES) throw new BotArtifactError('BOT_ARTIFACT_RESPONSE_TOO_LARGE', 413);
      return res.type('json').send(body);
    } catch (error) {
      return res.status(error instanceof BotArtifactError ? error.status : error instanceof z.ZodError ? 400 : 500)
        .json({ code: error instanceof BotArtifactError ? error.code : 'BOT_ARTIFACT_SERVICE_FAILED' });
    }
  });
}
