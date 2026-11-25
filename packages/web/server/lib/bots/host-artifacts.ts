import { createBotArtifactBindings } from './artifacts-bindings.js';
import { createBotArtifacts } from './artifacts-owner.js';
import { createBotArtifactExecution } from './artifacts-execution.js';
import { registerBotArtifactRoutes } from './artifacts-routes.js';
import type { HostOptions, HostIsolated, HostPlacement } from './host-contracts.js';
import type { createBotStore } from './store.js';
import type { createBotExecutionStore } from './execution-store.js';
import type { BotArtifactTransport } from '../agent-server/bot-artifact-service-contract.js';
import type { Application } from '../shared/http-contracts.js';
import type { createBotsRuntime } from './runtime.js';
import type { createSessionActivityProbe } from '../opencode/session-activity.js';
import { BotArtifactError } from './artifacts-contract.js';

type Options = Pick<HostOptions, 'dataDir' | 'listProjects' | 'resolveProject' | 'clientFor' | 'updateMetadata' | 'readArtifactPage' | 'executionServices' | 'broadcast'> & {
  readonly store: ReturnType<typeof createBotStore>;
  readonly journal: ReturnType<typeof createBotExecutionStore>;
  readonly placement: HostPlacement;
  readonly isolated: HostIsolated;
  readonly dispatchConversationNative: ReturnType<typeof createBotsRuntime>['dispatchConversationNative'];
  readonly activity: ReturnType<typeof createSessionActivityProbe> | null;
};

export function createHostArtifacts(options: Options) {
  const { dataDir, isolated, executionServices, clientFor, broadcast } = options;
  const bindings = createBotArtifactBindings(options);
  const transportFor = async (binding: Parameters<BotArtifactTransport['pull']>[0]['binding']) => {
    const space = binding.producer.role === 'stage' ? await isolated.readBinding(binding) : null;
    if (space) return isolated.artifactTransport(binding.sessionId);
    if (executionServices) return executionServices.artifacts;
    if (!local) throw new TypeError('Local artifact capture is unavailable');
    return local.service;
  };
  const artifacts = createBotArtifacts({ dataDir, resolveBinding: bindings.resolve, assertReadScope: bindings.assertReadScope,
    readPage: async (manifest) => {
      if (manifest.metadata.interaction === 'none' || manifest.metadata.interaction === 'share') return { kind: 'show' };
      const transport = await transportFor(manifest.binding);
      return (await transport.page({ binding: manifest.binding, id: manifest.metadata.id })).page;
    },
  });
  let localOptions: Parameters<typeof createBotArtifactExecution>[0] = {
    resolveBinding: bindings.resolve,
    dataDir, readSession: (sessionID) => clientFor('').session.get({ sessionID }),
    updateMetadata: async (sessionId, patch) => { await options.updateMetadata?.(sessionId, patch); },
    stopProducer: async (binding) => {
      if (!options.activity) throw new BotArtifactError('BOT_ARTIFACT_PRODUCER_STOP_REQUIRED', 503);
      await clientFor(binding.directory).session.interrupt({ sessionID: binding.sessionId });
      const active = await options.activity.fetchActiveSessionStatuses();
      if (active === null || active[binding.sessionId]
        || await options.activity.hasWorkingDescendants(binding.sessionId, active) !== false) throw new BotArtifactError('BOT_ARTIFACT_PRODUCER_NOT_STOPPED');
    },
    publish: async (manifest, bytes) => {
      const result = await artifacts.publish(manifest.binding, manifest, bytes);
      broadcast({ type: 'openchamber:bots-changed', properties: { projectId: manifest.binding.projectId } });
      return result;
    },
  };
  if (options.readArtifactPage) localOptions = { ...localOptions, readPage: options.readArtifactPage };
  const local = executionServices ? null : createBotArtifactExecution(localOptions);
  const collections = new Map<string, { readonly state: { again: boolean }; readonly promise: Promise<void> }>();
  const pendingDeliveries = new Set<string>();
  const collect = (sessionId: string): Promise<void> => {
    const previous = collections.get(sessionId);
    if (previous) { previous.state.again = true; return previous.promise; }
    const state = { again: false };
    const promise = (async () => {
      do {
        state.again = false;
        const binding = await bindings.resolve(sessionId);
        if (!binding) return;
        const space = binding.producer.role === 'stage' ? await isolated.readBinding(binding) : null;
        if (space?.state === 'removed' || space?.artifactsCollected) return;
        const transport = await transportFor(binding);
        await transport.drain({ binding });
        const { collected } = await artifacts.collect(binding, transport);
        if (collected) broadcast({ type: 'openchamber:bots-changed', properties: { projectId: binding.projectId } });
        if (binding.producer.role === 'conversation') {
          for (let count = 0; count < 4096; count += 1) {
            const page = await transport.deliveries({ binding, offset: 0 });
            const body = page.entries[0];
            if (!body) { pendingDeliveries.delete(sessionId); break; }
            pendingDeliveries.add(sessionId);
            await options.dispatchConversationNative({ sessionId, directory: binding.directory,
              operation: 'synthetic', operationId: `render-delivery:${body.id}`, payload: body });
            await transport.settleDelivery({ binding, id: body.id });
            if (page.nextOffset === null) { pendingDeliveries.delete(sessionId); break; }
          }
        }
      } while (state.again);
    })().finally(() => collections.delete(sessionId));
    collections.set(sessionId, { state, promise });
    return promise;
  };
  const recover = async (spaceId?: string) => {
    const inventory = await bindings.list();
    const failures = [...inventory.failures];
    for (const binding of inventory.bindings) {
      if (spaceId && (binding.producer.role !== 'stage' || (await isolated.readBinding(binding))?.spaceId !== spaceId)) continue;
      try { await collect(binding.sessionId); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Bot artifact recovery is incomplete');
  };
  return { local, artifacts, bindings, collect, recover,
    hasPendingDelivery: (sessionId: string) => pendingDeliveries.has(sessionId),
    async beforeRemove(scope: { readonly projectId: string; readonly itemId: string }) {
      for (const binding of await bindings.forItem(scope)) {
        if (binding.producer.role !== 'stage' || await isolated.readBinding(scope)) continue;
        const transport = await transportFor(binding);
        await transport.quiesce({ binding });
        await collect(binding.sessionId);
      }
    },
    async flush() {
      const settled = await Promise.allSettled([...collections.values()].map((entry) => entry.promise).concat(local ? [local.capture.flush()] : []));
      const failures: unknown[] = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
      try { await artifacts.flush(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Bot artifact shutdown could not fully drain');
    },
    registerRoutes: (app: Application) => registerBotArtifactRoutes(app, { artifacts }),
  };
}
