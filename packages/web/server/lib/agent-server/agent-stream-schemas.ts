import { z } from 'zod';
import { browserControlActionSchema } from '@openchamber/sdk/schemas';
import type { JsonObject } from '../event-stream/contracts.js';
import { isRecord } from '../shared/guards.js';

import { automationEventSchemas } from './automation-event-schemas.js';
import { browserRequestSchema } from './browser-request-schema.js';
import { fixLoopEventSchema } from './fix-loop-event-schema.js';
import { sessionEventSchemas, notificationEventSchemas } from './session-event-schemas.js';
import { trackedItemEventSchema } from './tracked-item-event-schema.js';
import { directory, id, sessionId, text, time, stripProvenance } from './stream-fields.js';

export type AgentStreamSource = 'control' | 'notifications';
export type AgentStreamLogger = { readonly warn?: (message: string) => void };
function eventSchema<Type extends string, Properties extends JsonObject>(type: Type, schema: z.ZodType<Properties>) {
  return [type, schema.transform((properties) => ({
    type, origin: 'agent' as const, spaceId: null,
    properties: {
      ...stripProvenance(properties),
      origin: 'agent' as const, spaceId: null,
    },
  }))] as const;
}

const controlProperties = {
  ...automationEventSchemas, ...sessionEventSchemas,
  'openchamber:browser-control-request': browserRequestSchema,
  'openchamber:pr-fix-loop.updated': fixLoopEventSchema,
  'openchamber:tracked-items.changed': trackedItemEventSchema,
  'openchamber:file-open-request': z.object({ path: directory, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:plan-open-request': z.object({ projectId: id, planId: id, title: text, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:browser-agent-activity': z.object({ guestId: id, action: browserControlActionSchema, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:scheduled-task-ran': z.object({ projectId: id, taskId: id, ranAt: time, status: z.enum(['running', 'sent', 'success', 'error']), sessionId: sessionId.optional() }),
  'openchamber:worktree-changed': z.object({ directories: z.array(directory).min(1).max(10_000), at: time.optional() }),
  'openchamber:agent-memory-changed': z.object({ scope: z.enum(['global', 'project']), projectId: id.optional() }),
  'openchamber:project-context-changed': z.object({ projectId: id }),
  'openchamber:suggested-tasks-changed': z.object({ projectId: id }),
  'openchamber:session-folders-changed': z.object({ updatedAt: time }),
  'openchamber:session-drafts-changed': z.object({ updatedAt: time }),
  'openchamber:source-control.activity': z.object({ directory }),
  'openchamber:guest-files-changed': z.object({ guestId: id, watchId: id, paths: z.array(directory).max(16) }),
  'openchamber:terminal-sessions-changed': z.object({}),
  'openchamber:source-control-providers-changed': z.object({}),
  'openchamber:tracker-providers-changed': z.object({}),
  'openchamber:guests-changed': z.object({}),
  'openchamber:limit-failover': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('account'), sessionId, providerId: id, fromAccount: text.nullable(), toAccount: id }),
    z.object({ kind: z.literal('model'), sessionId, providerId: id, modelId: id, toProviderId: id, toModelId: id }),
  ]),
  'openchamber:routing.updated': z.object({ available: z.boolean(), autoReady: z.boolean(), jevAvailable: z.boolean().optional(), tokenPresent: z.boolean(), jevSource: z.enum(['typesafe', 'zen-free']) }),
  'openchamber:routing.decision': z.object({
    sessionId, at: time, category: text.nullable(), confidence: time,
    reason: z.enum(['routed', 'low-confidence', 'unknown-category', 'error', 'not-ready']),
    providerID: id.optional(), modelID: id.optional(), variant: text.nullable().optional(), agent: text.nullable().optional(), error: text.optional(),
  }),
  'openchamber:routing.permission-held': z.object({ permissionId: id, sessionId, directory: directory.nullable(), score: time, kind: text.nullable() }),
  'openchamber:routing.safety-skipped': z.object({ permissionId: id, sessionId, directory: directory.nullable(), error: text }),
};
const controlSchemas = [
  eventSchema('openchamber:message-queue.updated', controlProperties['openchamber:message-queue.updated']),
  eventSchema('openchamber:auto-review.updated', controlProperties['openchamber:auto-review.updated']),
  eventSchema('openchamber:pr-watch.updated', controlProperties['openchamber:pr-watch.updated']),
  eventSchema('openchamber:workflow-run', controlProperties['openchamber:workflow-run']),
  eventSchema('openchamber:workflow-run-removed', controlProperties['openchamber:workflow-run-removed']),
  eventSchema('openchamber:session-warming', controlProperties['openchamber:session-warming']),
  eventSchema('openchamber:pr-stack.restack', controlProperties['openchamber:pr-stack.restack']),
  eventSchema('openchamber:session-metadata', controlProperties['openchamber:session-metadata']),
  eventSchema('openchamber:session-assist', controlProperties['openchamber:session-assist']),
  eventSchema('openchamber:session-archived', controlProperties['openchamber:session-archived']),
  eventSchema('openchamber:session-created', controlProperties['openchamber:session-created']),
  eventSchema('openchamber:page-waiting', controlProperties['openchamber:page-waiting']),
  eventSchema('openchamber:page-settled', controlProperties['openchamber:page-settled']),
  eventSchema('openchamber:browser-control-request', controlProperties['openchamber:browser-control-request']),
  eventSchema('openchamber:pr-fix-loop.updated', controlProperties['openchamber:pr-fix-loop.updated']),
  eventSchema('openchamber:tracked-items.changed', controlProperties['openchamber:tracked-items.changed']),
  eventSchema('openchamber:file-open-request', controlProperties['openchamber:file-open-request']),
  eventSchema('openchamber:plan-open-request', controlProperties['openchamber:plan-open-request']),
  eventSchema('openchamber:browser-agent-activity', controlProperties['openchamber:browser-agent-activity']),
  eventSchema('openchamber:scheduled-task-ran', controlProperties['openchamber:scheduled-task-ran']),
  eventSchema('openchamber:worktree-changed', controlProperties['openchamber:worktree-changed']),
  eventSchema('openchamber:agent-memory-changed', controlProperties['openchamber:agent-memory-changed']),
  eventSchema('openchamber:project-context-changed', controlProperties['openchamber:project-context-changed']),
  eventSchema('openchamber:suggested-tasks-changed', controlProperties['openchamber:suggested-tasks-changed']),
  eventSchema('openchamber:session-folders-changed', controlProperties['openchamber:session-folders-changed']),
  eventSchema('openchamber:session-drafts-changed', controlProperties['openchamber:session-drafts-changed']),
  eventSchema('openchamber:source-control.activity', controlProperties['openchamber:source-control.activity']),
  eventSchema('openchamber:guest-files-changed', controlProperties['openchamber:guest-files-changed']),
  eventSchema('openchamber:terminal-sessions-changed', controlProperties['openchamber:terminal-sessions-changed']),
  eventSchema('openchamber:source-control-providers-changed', controlProperties['openchamber:source-control-providers-changed']),
  eventSchema('openchamber:tracker-providers-changed', controlProperties['openchamber:tracker-providers-changed']),
  eventSchema('openchamber:guests-changed', controlProperties['openchamber:guests-changed']),
  eventSchema('openchamber:limit-failover', controlProperties['openchamber:limit-failover']),
  eventSchema('openchamber:routing.updated', controlProperties['openchamber:routing.updated']),
  eventSchema('openchamber:routing.decision', controlProperties['openchamber:routing.decision']),
  eventSchema('openchamber:routing.permission-held', controlProperties['openchamber:routing.permission-held']),
  eventSchema('openchamber:routing.safety-skipped', controlProperties['openchamber:routing.safety-skipped']),
] as const;
const notificationSchemas = [
  eventSchema('openchamber:notification', notificationEventSchemas['openchamber:notification'].transform((properties) => ({
    ...properties, desktopNotificationDelivered: false, desktopStdoutActive: false,
  }))),
  eventSchema('openchamber:permission-auto-accept.updated', notificationEventSchemas['openchamber:permission-auto-accept.updated']),
  eventSchema('openchamber:permission-auto-accept.left-for-user', notificationEventSchemas['openchamber:permission-auto-accept.left-for-user']),
  eventSchema('openchamber:session-status', notificationEventSchemas['openchamber:session-status']),
  eventSchema('openchamber:session-activity', notificationEventSchemas['openchamber:session-activity']),
] as const;
export type AgentStreamEvent = z.output<(typeof controlSchemas | typeof notificationSchemas)[number][1]>;
const controlParsers = new Map<string, z.ZodType<AgentStreamEvent>>(controlSchemas);
const notificationParsers = new Map<string, z.ZodType<AgentStreamEvent>>(notificationSchemas);
const envelopeSchema = z.object({ type: z.string().min(1).max(128), properties: z.unknown() });
// The type a refused event is logged under.
const loggedTypeSchema = z.string().catch('invalid');
const internalTypes = new Set(['openchamber:event-stream-ready', 'openchamber:notification-stream-ready', 'openchamber:heartbeat']);

/** One owner stream per type avoids duplicate delivery of shared SSE events. */
export function parseAgentStreamEvent(payload: unknown, source: AgentStreamSource, logger: AgentStreamLogger): AgentStreamEvent | null {
  const envelope = envelopeSchema.safeParse(payload);
  const type = envelope.success ? envelope.data.type : loggedTypeSchema.parse(isRecord(payload) ? payload.type : undefined);
  if (internalTypes.has(type)) return null;
  const schema = (source === 'control' ? controlParsers : notificationParsers).get(type);
  // Notification and permission broadcasts appear on both streams in the agent.
  if (source === 'control' && Object.hasOwn(notificationEventSchemas, type)) return null;
  const event = envelope.success && schema ? schema.safeParse(envelope.data.properties) : null;
  if (!event?.success) {
    logger.warn?.(`[agent-streams] dropped ${type.slice(0, 128).replace(/[^a-zA-Z0-9:._-]/g, '_')}`);
    return null;
  }
  return event.data;
}
