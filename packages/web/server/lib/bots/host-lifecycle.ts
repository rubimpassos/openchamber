import { BotServiceError } from './services.js';
import { failureCode } from './host-failures.js';
import type { HostIsolated, HostSessions, ReportHostAttention } from './host-contracts.js';
import type { createBotsRuntime } from './runtime.js';
import type { createBotProviderRuntime } from './provider-runtime.js';
import type { createBotDiscovery } from './discovery.js';
import type { createBotHostTools } from './host-tools.js';
import type { createHostArtifacts } from './host-artifacts.js';

type LifecycleOptions = {
  readonly runtime: ReturnType<typeof createBotsRuntime>;
  readonly isolated: HostIsolated; readonly sessions: HostSessions;
  readonly providers: ReturnType<typeof createBotProviderRuntime>;
  readonly discovery: ReturnType<typeof createBotDiscovery>;
  readonly hostTools: ReturnType<typeof createBotHostTools> | null;
  readonly artifacts: ReturnType<typeof createHostArtifacts>;
  readonly listProjects: () => Promise<readonly { readonly id: string }[]>;
  readonly refreshIndex: (projectId: string) => Promise<void>;
  readonly reportAttention: ReportHostAttention;
  readonly release: () => void;
  readonly logger: Pick<Console, 'warn'>;
};
type StartResult = { readonly failures: readonly { readonly projectId: string; readonly code: string }[] };

export function createHostLifecycle({ runtime, isolated, sessions, providers, discovery, hostTools, artifacts,
  listProjects, refreshIndex, reportAttention, release, logger }: LifecycleOptions) {
  let started = false;
  let stopping = false;
  let startup: Promise<StartResult> | null = null;
  const work = new Set<Promise<unknown>>();
  const observe = <Value>(promise: PromiseLike<Value> | Value) => {
    const operation = Promise.resolve(promise).catch((error) => logger.warn('[bots]', failureCode.parse(error)));
    work.add(operation); void operation.finally(() => work.delete(operation)); return operation;
  };
  return {
    get started() { return started; },
    get stopping() { return stopping; },
    observe,
    assertStarted() {
      if (!started || stopping) throw new BotServiceError('BOT_HOST_NOT_READY', 'The bot host is waiting for OpenCode readiness.', 'needs-you', 503);
    },
    start(): Promise<StartResult> {
      if (startup) return startup;
      if (stopping) return Promise.resolve({ failures: [] });
      startup = (async () => {
        const failures: { projectId: string; code: string }[] = [];
        for (const binding of await isolated.bindings()) {
          if (binding.state === 'removed') continue;
          for (const session of Object.values(binding.sessions)) sessions.track({ projectId: binding.projectId, botId: binding.botId,
            itemId: binding.itemId, sessionId: session.id, directory: binding.hostDirectory, stage: session.stage, isolated: true });
        }
        for (const project of await listProjects()) {
          try { await refreshIndex(project.id); }
          catch (error) { failures.push({ projectId: project.id, code: failureCode.parse(error) }); }
        }
        if (stopping) return { failures };
        started = true;
        const recovered = await runtime.start();
        if (stopping) return { failures: [...failures, ...recovered.failures] };
        await sessions.restore(async (entry, error) => { await reportAttention({ ...entry, reason: failureCode.parse(error) }); });
        observe(artifacts.recover());
        for (const entry of sessions.entries()) if (entry.isolated && entry.stage === 'fixing') observe((async () => {
          const binding = await isolated.bindingFor({ sessionId: entry.sessionId });
          await isolated.forwardTools({ spaceId: binding.spaceId, sessionId: entry.sessionId })
            .catch((error) => reportAttention({ ...entry, reason: failureCode.parse(error) }));
        })());
        for (const entry of sessions.entries()) if (!entry.isolated && entry.stage === 'fixing' && hostTools) {
          observe(hostTools.forward(entry).catch((error) => reportAttention({ ...entry, reason: failureCode.parse(error) })));
        }
        if (!stopping) await providers.start();
        if (!stopping) await discovery.start();
        return { failures: [...failures, ...recovered.failures] };
      })();
      return startup;
    },
    async stop() {
      stopping = true;
      const failures: unknown[] = [];
      const cancellation = runtime.stop().catch((error) => { failures.push(error); });
      try { await startup; } catch (error) { failures.push(error); }
      await cancellation;
      const drain = async () => { while (work.size) await Promise.all([...work]); };
      for (const stop of [providers.stop, discovery.stop, drain, sessions.stop, artifacts.flush]) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      release(); started = false;
      if (failures.length) throw new AggregateError(failures, 'Bot host shutdown could not fully drain');
    },
  };
}
