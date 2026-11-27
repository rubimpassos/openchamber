import { z } from 'zod';
import type { BotItem } from './schema.js';
import type { createBotsRuntime } from './runtime.js';
import type { createBotPlacement } from './placement.js';
import type { createBotHostSessions } from './host-sessions.js';
import type { createBotProviderRuntime } from './provider-runtime.js';
import type { createBotDiscovery } from './discovery.js';

type Runtime = ReturnType<typeof createBotsRuntime>;
type Sessions = ReturnType<typeof createBotHostSessions>;
type Entry = NonNullable<ReturnType<Sessions['get']>>;
const failureSchema = z.object({ code: z.string().optional(), status: z.number().optional() });
type Failure = z.output<typeof failureSchema>;
type ApiOptions = {
  readonly runtime: Runtime;
  readonly placement: Pick<ReturnType<typeof createBotPlacement>, 'sessionDirectories'>;
  readonly sessions: Pick<Sessions, 'get'>;
  readonly providers: Pick<ReturnType<typeof createBotProviderRuntime>, 'reconfigure'>;
  readonly discovery: Pick<ReturnType<typeof createBotDiscovery>, 'reconfigure'>;
  readonly runScheduled: Runtime['runScheduled'];
  readonly assertStarted: () => void;
  readonly refreshIndex: (projectId: string) => Promise<void>;
  readonly broadcast: (event: { readonly type: 'openchamber:bots-changed'; readonly properties: { readonly projectId: string } }) => void;
  readonly reportAttention: (entry: Entry & { readonly reason: string }) => Promise<BotItem | void>;
  readonly failureCode: (error: Failure) => string;
};

export function createBotHostApi({ runtime, placement, sessions, providers, discovery, runScheduled,
  assertStarted, refreshIndex, broadcast, reportAttention, failureCode }: ApiOptions) {
  const detail = async (...args: Parameters<Runtime['detail']>) => {
    const result = await runtime.detail(...args);
    const sessionDirectories = { ...await placement.sessionDirectories({ projectId: args[0], item: result.item }) };
    if (result.item.conversation) sessionDirectories[result.item.conversation.sessionId] = result.item.conversation.directory;
    return { ...result, sessionDirectories };
  };
  return {
    ...runtime,
    runScheduled,
    detail,
    ensureConversation(...args: Parameters<Runtime['ensureConversation']>) {
      assertStarted(); return runtime.ensureConversation(...args);
    },
    async saveConfig(...args: Parameters<Runtime['saveConfig']>) {
      assertStarted();
      const result = await runtime.saveConfig(...args);
      await refreshIndex(args[0]);
      await providers.reconfigure();
      await discovery.reconfigure();
      broadcast({ type: 'openchamber:bots-changed', properties: { projectId: args[0] } });
      return result;
    },
    async saveDefinitions(...args: Parameters<Runtime['saveDefinitions']>) {
      assertStarted();
      const result = await runtime.saveDefinitions(...args);
      await providers.reconfigure();
      await discovery.reconfigure();
      return result;
    },
    async approvePolicy(...args: Parameters<Runtime['approvePolicy']>) {
      const result = await runtime.approvePolicy(...args);
      await providers.reconfigure();
      await runtime.pump(args[0]);
      return result;
    },
    admit(...args: Parameters<Runtime['admit']>) { assertStarted(); return runtime.admit(...args); },
    pump(...args: Parameters<Runtime['pump']>) { assertStarted(); return runtime.pump(...args); },
    async answer(...args: Parameters<Runtime['answer']>) {
      assertStarted(); await runtime.answer(...args); return detail(args[0], args[1]);
    },
    async resume(...args: Parameters<Runtime['resume']>) {
      assertStarted(); await runtime.resume(...args); return detail(...args);
    },
    async stopItem(projectId: string, itemId: string) {
      assertStarted(); await runtime.stopItem(projectId, itemId); return detail(projectId, itemId);
    },
    async handleTool(request: Parameters<Runtime['handleTool']>[0]) {
      assertStarted();
      try { return await runtime.handleTool(request); }
      catch (error) {
        const entry = sessions.get(request.sessionId);
        const parsed = failureSchema.safeParse(error);
        const failure = parsed.success ? parsed.data : {};
        if (entry && entry.role !== 'conversation' && failure.status !== 400) await reportAttention({ ...entry, reason: failureCode(failure) });
        throw error;
      }
    },
  };
}
