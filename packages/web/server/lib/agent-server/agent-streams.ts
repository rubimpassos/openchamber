import { createUpstreamSseReader, UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS } from '../event-stream/upstream-reader.js';
import { parseAgentStreamEvent } from './agent-stream-schemas.js';
import { isAgentPayloadAllowed } from './session-boundary.js';
import { z } from 'zod';
import { id, time } from './stream-fields.js';
import { isRecord } from '../shared/guards.js';
import type { AgentUpstream } from './agent-upstream.js';
import type { AgentStreamEvent, AgentStreamLogger } from './agent-stream-schemas.js';

type AgentStreamsOptions = {
  readonly upstream: Pick<AgentUpstream, 'buildUrl' | 'fetch'>;
  readonly broadcastUiEvent: (event: AgentStreamEvent) => void;
  readonly broadcastGlobalUiEvent: (event: AgentStreamEvent) => void;
  readonly onControlConnection?: (connectionId: string | null) => void;
  readonly isSpaceSession?: (sessionId: string) => boolean;
  readonly isOwnerFixLoopIdentity?: (id: string) => boolean;
  readonly logger?: AgentStreamLogger;
};

const readySchema = z.object({ type: z.literal('openchamber:event-stream-ready'), properties: z.object({ connectionId: id, connectedAt: time }) });

/**
 * Auth and event-size bounds belong to upstream.fetch; this owns typed fanout.
 * The global callback also delivers to control SSE clients, as the server's
 * permission broadcaster does. Shared types are read only from notifications.
 */
export function createAgentStreams({ upstream, broadcastUiEvent, broadcastGlobalUiEvent, onControlConnection = () => {}, isSpaceSession = () => false, isOwnerFixLoopIdentity = () => false, logger = console }: AgentStreamsOptions) {
  let controller: AbortController | null = null;
  let readers: ReturnType<typeof createUpstreamSseReader>[] = [];
  let completion: Promise<void | void[]> = Promise.resolve();
  return {
    start() {
      if (controller) return;
      const activeController = new AbortController();
      controller = activeController;
      readers = ([
        ['control', '/api/openchamber/events?browser=1', broadcastUiEvent],
        ['notifications', '/api/notifications/stream', broadcastGlobalUiEvent],
      ] as const).map(([source, route, broadcast]) => createUpstreamSseReader({
        signal: activeController.signal,
        buildUrl: () => upstream.buildUrl(route),
        fetchImpl: (url, options) => upstream.fetch(url, options),
        stallTimeoutMs: UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
        reconnectDelayMs: 1000,
        reconnectMaxDelayMs: 60_000,
        onEvent({ payload }) {
          if (source === 'control' && isRecord(payload) && payload.type === 'openchamber:event-stream-ready') {
            const ready = readySchema.safeParse(payload);
            if (ready.success) onControlConnection(ready.data.properties.connectionId);
            return;
          }
          const event = parseAgentStreamEvent(payload, source, logger);
          if (event?.type === 'openchamber:pr-fix-loop.updated') {
            const identity = 'loop' in event.properties ? event.properties.loop.id : event.properties.id;
            if (isOwnerFixLoopIdentity(identity)) return;
          }
          if (!event || !isAgentPayloadAllowed(event, isSpaceSession)) return;
          broadcast(event);
        },
        onDisconnect() {
          if (source === 'control') onControlConnection(null);
        },
        onError(error) {
          if (!controller?.signal.aborted) logger.warn?.(`[agent-streams] ${source} ${error.type === 'upstream_unavailable' ? 'unavailable' : 'stream_error'}`);
        },
      }));
      completion = Promise.all(readers.map((reader) => reader.start()));
    },
    close() {
      controller?.abort();
      for (const reader of readers) reader.stop();
      return completion;
    },
  };
}
