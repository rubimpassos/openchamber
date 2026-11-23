import express from 'express';
import { asNonEmptyString, isBoolean, hasProperties } from '../shared/guards.js';
import { parseTrackedItems, trackedItemKey } from '../tracked-items/items.js';
import { AgentUpstreamError } from './agent-upstream.js';
import { trackedItemEventSchema } from './tracked-item-event-schema.js';
import type { AgentUpstream } from './agent-upstream.js';
import type { TrackedItemEvent } from './tracked-item-event-schema.js';
import type { TrackedItem } from '../tracked-items/contracts.js';
import type { Application, Response } from '../shared/http-contracts.js';

type InterestConnection = {
  readonly items: ReadonlyMap<string, TrackedItem>;
  readonly visible: boolean;
  readonly revision: number;
};
type SentInterest = { readonly signature: string; readonly connectionId: string; readonly visible: boolean };
type TrackedStates = TrackedItemEvent['states'];

// Same per-interest bound as the agent's tracked-items routes and event schema.
const MAX_ITEMS = 300;
const connectionText = (value: unknown) => asNonEmptyString(value) ?? '';

/** UI connections belong here; only the upstream control connection reaches the agent. */
export function createFrontDoorTrackedItems({ upstream }: { readonly upstream: Pick<AgentUpstream, 'json'> }) {
  const connections = new Map<string, InterestConnection>();
  let revision = 0;
  let controlId: string | null = null;
  let sent: SentInterest | null = null;
  let pending: Promise<TrackedStates | undefined> = Promise.resolve(undefined);

  const snapshot = () => {
    const items = new Map<string, TrackedItem>();
    const ordered = [...connections.values()].sort((a, b) => Number(b.visible) - Number(a.visible) || b.revision - a.revision);
    for (const connection of ordered) for (const [key, item] of connection.items) {
      if (items.size < MAX_ITEMS && !items.has(key)) items.set(key, item);
    }
    return { items, visible: ordered.some((connection) => connection.visible) };
  };

  function synchronize(answerInterest: true): Promise<TrackedStates>;
  function synchronize(answerInterest?: false): Promise<TrackedStates | undefined>;
  function synchronize(answerInterest = false): Promise<TrackedStates | undefined> {
    const operation = pending.then(async () => {
      const connectionId = controlId;
      if (!connectionId) throw new AgentUpstreamError('agent_control_unavailable');
      const { items, visible } = snapshot();
      const signature = JSON.stringify([connectionId, visible, [...items.keys()].sort()]);
      if (!answerInterest && sent?.signature === signature) return;
      // Preserve the agent's refresh-on-return floor before interest replaces
      // visibility. Each UI interest still reads a fresh answer from the agent.
      if (sent?.connectionId === connectionId && sent.visible !== visible) {
        await upstream.json('/api/tracked-items/presence', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ connectionId, visible }),
        });
      }
      if (controlId !== connectionId) throw new AgentUpstreamError('agent_control_unavailable');
      const answer = await upstream.json('/api/tracked-items/interest', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId, visible, items: [...items.values()] }),
      });
      const parsed = trackedItemEventSchema.safeParse(answer);
      if (!parsed.success || parsed.data.states.some((record) => {
        if (record.item.kind === 'work-item') return record.key !== trackedItemKey(record.item);
        // Zod optional fields include undefined; the item key contract omits an absent account.
        const { accountId, ...thread } = record.item;
        return record.key !== trackedItemKey({ ...thread, ...(accountId === undefined ? {} : { accountId }) });
      })) {
        throw new AgentUpstreamError('agent_invalid_response');
      }
      if (controlId !== connectionId) throw new AgentUpstreamError('agent_control_unavailable');
      const states = parsed.data.states.filter((record) => items.has(record.key));
      sent = { signature, connectionId, visible };
      return states;
    });
    // Failed sends leave the local interests intact for the next request/reconnect.
    pending = operation.catch(() => undefined);
    return operation;
  }

  return {
    openConnection(connectionId: string) {
      connections.set(connectionId, { items: new Map(), visible: false, revision: 0 });
    },
    closeConnection(connectionId: string) {
      if (!connections.delete(connectionId)) return pending;
      return synchronize();
    },
    setControlConnection(connectionId: string | null) {
      controlId = connectionId;
      sent = null;
      return connectionId ? synchronize() : pending;
    },
    async setInterest(connectionId: string, items: ReadonlyMap<string, TrackedItem>, { visible = true }: { readonly visible?: boolean } = {}) {
      if (!connections.has(connectionId)) {
        throw Object.assign(new Error('The event stream connection is not open'), { code: 'unknown-connection' });
      }
      connections.set(connectionId, { items, visible, revision: ++revision });
      const states = await synchronize(true);
      return states.filter((record) => items.has(record.key));
    },
    async setPresence(connectionId: string, visible: boolean) {
      const connection = connections.get(connectionId);
      if (!connection) return;
      connections.set(connectionId, { ...connection, visible, revision: ++revision });
      await synchronize();
    },
  };
}

export function registerFrontDoorTrackedItemsRoutes(app: Application, { service }: {
  readonly service: Pick<ReturnType<typeof createFrontDoorTrackedItems>, 'setInterest' | 'setPresence'>;
}) {
  const json = express.json({ limit: '128kb' });
  const respondError = (res: Response, error: unknown) => {
    const code = hasProperties(error) && error.code === 'unknown-connection' ? 'unknown-connection'
      : error instanceof AgentUpstreamError ? error.code : 'agent_unreachable';
    return res.status(code === 'unknown-connection' ? 409 : 503).json({ code, error: code });
  };
  app.post('/api/tracked-items/interest', json, async (req, res) => {
    const body = hasProperties(req.body) ? req.body : undefined;
    const connectionId = connectionText(body?.connectionId);
    const items = parseTrackedItems(Array.isArray(body?.items) ? body.items : undefined, MAX_ITEMS);
    if (!connectionId || !items) return res.status(400).json({ error: `connectionId and at most ${MAX_ITEMS} items are required` });
    try {
      const states = await service.setInterest(connectionId, items, { visible: body?.visible !== false });
      return res.json({ states });
    } catch (error) { return respondError(res, error); }
  });
  app.post('/api/tracked-items/presence', json, async (req, res) => {
    const body = hasProperties(req.body) ? req.body : undefined;
    const connectionId = connectionText(body?.connectionId);
    if (!connectionId || !isBoolean(body?.visible)) return res.status(400).json({ error: 'connectionId and visible are required' });
    try {
      await service.setPresence(connectionId, body.visible);
      return res.json({ ok: true });
    } catch (error) { return respondError(res, error); }
  });
}
