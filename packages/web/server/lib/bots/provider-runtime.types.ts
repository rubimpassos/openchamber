import type { createBotsConfig, BotDefinition } from './config.js';
import type { createBotStore } from './store.js';
import type { createBotIdentityStore } from './identities.js';
import type { createBotProviderEventStore, pollBotJiraComments } from './provider-events.js';
import type { createBotDiscordGateway } from './discord-gateway.js';
import type { createBotServiceContext } from './service-context.js';
import type { createBotsRuntime } from './runtime.js';
import type { readRepositoryPolicy } from './repository-policy.js';
import type { ProviderHttpOptions } from './services/http.js';
import type { CredentialResolverOptions } from './services/credentials.js';
import type { BotItem } from './schema.js';
import type { WebSocket, RawData } from '../shared/websocket-contracts.js';

export type ProviderEventStore = ReturnType<typeof createBotProviderEventStore>;
export type ProviderEvent = Parameters<Parameters<ProviderEventStore['drain']>[1]>[0];
export type DiscordCursor = Extract<Awaited<ReturnType<ProviderEventStore['read']>>['cursor'], object>;
export type ProviderProject = { readonly id: string; readonly path: string };
export type ProviderScope = { readonly project: ProviderProject; readonly bot: BotDefinition; readonly item: Pick<BotItem, 'id'> };
export type ProviderAttention = { readonly projectId?: string; readonly botId?: string; readonly itemId?: string };
export type ProviderFailure = ProviderAttention & { readonly code: string };
export type SelectedIdentity = { readonly identityId: string; readonly identityRevision: number; site?: string };
export type ProviderGatewaySocket = Pick<WebSocket, 'readyState' | 'send' | 'terminate'> & {
  on(event: 'message', listener: (data: RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
};
export type GatewayOptions = Pick<ProviderHttpOptions, 'fetchImpl' | 'policyOptions'> & {
  readonly identities: CredentialResolverOptions['identities'];
  readonly identityId: string;
  readonly identityRevision: number;
  readonly channels?: readonly { readonly guildId: string; readonly channelId: string }[];
  readonly people?: readonly string[];
  readonly eventStore: ProviderEventStore;
  readonly deliver: Parameters<ProviderEventStore['drain']>[1];
  readonly onError?: (error: Error) => void;
  readonly createSocket?: (url: string, options: {
    readonly followRedirects: false; readonly maxPayload: number; readonly handshakeTimeout: number;
  }) => ProviderGatewaySocket;
  readonly random?: () => number;
  readonly now?: () => number;
};
export type ProviderGatewayOptions = Omit<GatewayOptions, 'identities'> & Pick<ProviderScope, 'project' | 'bot'> & {
  readonly identities: Pick<ReturnType<typeof createBotIdentityStore>, 'list'>;
};
export type ProviderRuntimeOptions = Pick<ProviderHttpOptions, 'fetchImpl' | 'policyOptions'> & {
  readonly dataDir: string;
  readonly config: Pick<ReturnType<typeof createBotsConfig>, 'read'>;
  readonly store: Pick<ReturnType<typeof createBotStore>, 'read'>;
  readonly services: Parameters<typeof pollBotJiraComments>[0]['services'];
  readonly runtime: Pick<ReturnType<typeof createBotsRuntime>, 'admit' | 'receiveFeedback' | 'answer' | 'pump'>;
  readonly listProjects: () => Promise<readonly Pick<ProviderProject, 'id'>[]>;
  readonly resolveProject: (projectId: string) => Promise<ProviderProject>;
  readonly serviceContext: ReturnType<typeof createBotServiceContext>['serviceContext'];
  readonly onNeedsYou: (request: ProviderAttention & { readonly state: 'needs-you'; readonly reason: string }) => void;
  readonly eventStore?: ProviderEventStore;
  readonly pollIntervalMs?: number;
  readonly readPolicy?: typeof readRepositoryPolicy;
} & (
  | { readonly identities: ProviderGatewayOptions['identities'] & GatewayOptions['identities']; readonly createGateway?: undefined }
  | { readonly identities: ProviderGatewayOptions['identities']; readonly createGateway: (options: ProviderGatewayOptions) => ReturnType<typeof createBotDiscordGateway> }
);
