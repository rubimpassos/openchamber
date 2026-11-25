import { BotServiceError } from './services.js';
import { failureCode } from './host-failures.js';
import { isJsonObject, isString } from '../event-stream/guards.js';
import type { HostEntry, HostIsolated, HostSessions, ReportHostAttention } from './host-contracts.js';
import type { createBotsRuntime } from './runtime.js';
import type { createBotDiscovery } from './discovery.js';
import type { createBotHostTools } from './host-tools.js';
import type { createHostLifecycle } from './host-lifecycle.js';
import type { TranslatedEvent } from '../event-stream/translate-v2.js';
import type { JsonObject } from '../event-stream/contracts.js';
import type { createHostArtifacts } from './host-artifacts.js';

type EventOptions = {
  readonly lifecycle: ReturnType<typeof createHostLifecycle>;
  readonly runtime: ReturnType<typeof createBotsRuntime>;
  readonly sessions: HostSessions; readonly isolated: HostIsolated;
  readonly discovery: ReturnType<typeof createBotDiscovery>;
  readonly hostTools: ReturnType<typeof createBotHostTools> | null;
  readonly reportAttention: ReportHostAttention;
  readonly artifacts: ReturnType<typeof createHostArtifacts>;
};
export function createHostPayloadProcessor({ lifecycle, runtime, sessions, isolated, discovery, hostTools, artifacts, reportAttention }: EventOptions) {
  const captured = new Map<string, string>();
  const usageReads = new Map<string, { readonly state: { again: boolean }; readonly promise: Promise<void> }>();
  const accountUsage = (entry: HostEntry) => {
    const previous = usageReads.get(entry.sessionId);
    if (previous) { previous.state.again = true; return previous.promise; }
    const state = { again: false };
    const promise = (async () => {
      do {
        state.again = false;
        const total = await sessions.tokenSnapshot(entry.sessionId, entry.directory);
        if (total === null) throw new BotServiceError('BOT_TOKEN_USAGE_UNAVAILABLE', 'Complete bot token usage is unavailable.');
        if (entry.itemId.startsWith('discovery_')) await discovery.recordUsage({ sessionId: entry.sessionId, total });
        else await runtime.recordUsage({ sessionId: entry.sessionId, total });
      } while (state.again && !lifecycle.stopping);
    })().finally(() => usageReads.delete(entry.sessionId));
    usageReads.set(entry.sessionId, { state, promise }); return promise;
  };
  return async (payload: TranslatedEvent, { spaceId = null }: { readonly spaceId?: string | null } = {}) => {
    if (!lifecycle.started || lifecycle.stopping) return;
    const properties: JsonObject = payload.properties;
    const info = isJsonObject(properties.info) ? properties.info : undefined;
    const time = info && isJsonObject(info.time) ? info.time : undefined;
    const metadata = info && isJsonObject(info.metadata) ? info.metadata : undefined;
    const openchamber = metadata && isJsonObject(metadata.openchamber) ? metadata.openchamber : undefined;
    const status = isJsonObject(properties.status) ? properties.status : undefined;
    const completed = payload.type === 'message.updated' && info?.role === 'assistant' && time?.completed !== undefined;
    const wake = payload.type === 'session.updated' && openchamber?.botToolPending;
    const artifactWake = payload.type === 'session.updated' && isString(openchamber?.botArtifactCaptured) ? openchamber.botArtifactCaptured : null;
    const deliveryWake = payload.type === 'session.updated' && isString(openchamber?.botConversationDeliveryPending) ? openchamber.botConversationDeliveryPending : null;
    const reason = payload.type === 'session.idle' || payload.type === 'session.status' && status?.type === 'idle' ? 'idle'
      : payload.type === 'session.error' ? 'BOT_SESSION_ERROR' : null;
    if (!completed && !wake && !artifactWake && !deliveryWake && !reason) return;
    const sessionId = properties.sessionID ?? info?.sessionID ?? info?.id;
    if (!isString(sessionId)) return;
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.isolated) {
      const binding = await isolated.bindingFor({ sessionId });
      if (binding.spaceId !== spaceId) return;
    } else if (spaceId) return;
    const captureWake = JSON.stringify([artifactWake, deliveryWake]);
    if ((artifactWake || deliveryWake) && captured.get(sessionId) !== captureWake) {
      captured.set(sessionId, captureWake);
      lifecycle.observe(artifacts.collect(sessionId).catch((error) => { captured.delete(sessionId); throw error; }));
    }
    sessions.processPayload(payload, { spaceId });
    if (entry.isolated && entry.stage === 'fixing' && wake && spaceId) {
      lifecycle.observe(isolated.forwardTools({ spaceId, sessionId }).catch((error) => reportAttention({ ...entry, reason: failureCode.parse(error) })));
    }
    if (!entry.isolated && entry.stage === 'fixing' && wake && hostTools) {
      lifecycle.observe(hostTools.forward(entry).catch((error) => reportAttention({ ...entry, reason: failureCode.parse(error) })));
    }
    if (completed || reason === 'idle') {
      if (reason === 'idle') await artifacts.collect(sessionId);
      try { await accountUsage(entry); }
      catch (error) {
        if (!entry.itemId.startsWith('discovery_') && (await runtime.detail(entry.projectId, entry.itemId)).item.state === 'needs-you') return;
        const failure = { sessionId, reason: failureCode.parse(error) };
        return entry.itemId.startsWith('discovery_') ? discovery.onSessionEvent(failure) : runtime.onSessionEvent(failure);
      }
    }
    if (!reason) return;
    return entry.itemId.startsWith('discovery_') ? discovery.onSessionEvent({ sessionId, reason }) : runtime.onSessionEvent({ sessionId, reason });
  };
}
