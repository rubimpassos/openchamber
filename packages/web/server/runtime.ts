import { installOpenCodeV2, supportsOpenCodeV2Install } from './lib/opencode/v2-install.js';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion } from './lib/opencode/compatibility.js';
import 'reflect-metadata';
import express from 'express';
import { buildRestartNotification } from './lib/notifications/restart-notification.js';
import compression from 'compression';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'node:http';
import { webPackagePaths } from './lib/web-package-paths.js';
import { stripOpenChamberPrivateEnv } from './lib/inherited-env.js';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { createUiAuth, getBearerTokenFromRequest } from './lib/ui-auth/ui-auth.js';
import { createTunnelAuth } from './lib/tunnels/tunnel-auth.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createNgrokTunnelProvider } from './lib/tunnels/providers/ngrok.js';
import { createTailscaleTunnelProvider } from './lib/tunnels/providers/tailscale.js';
import { allowsLocalDevOrigins, buildFrameAncestorsPolicy, createRequestSecurityRuntime, isLocalDevClientOrigin } from './lib/security/request-security.js';
import {
  getUnauthenticatedLanErrorMessage,
  isLoopbackBindHost,
  isNetworkExposedBindHost,
  isUiAuthConfigured,
  isUnsafeUnauthenticatedLanAllowed,
  readAdvertisedLanUrl,
} from './lib/security/bind-host.js';
import { isEnterpriseMode, isNetworkAccessBlocked, NETWORK_ACCESS_BLOCKED_ERROR, readEnterprisePolicy, watchEnterprisePolicy } from './lib/enterprise-mode.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { detectSayTtsCapability } from './lib/tts/capability-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createDictationRuntime } from './lib/dictation/runtime.js';
import {
  createGlobalUiEventBroadcaster,
  translateWireEvent,
  createGlobalMessageStreamHub,
  createMessageStreamWsRuntime,
  resolveDeltaCoalesceWindowMs,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS,
} from './lib/event-stream/index.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { providedLoginShellEnvSnapshot } from './lib/opencode/login-shell-env.js';
import { resolveOpenCodeEnvConfig, resolveProxyRequestTimeoutMs } from './lib/opencode/env-config.js';
import { createHmrStateRuntime } from './lib/opencode/hmr-state-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createOpenCodeAuthStateRuntime } from './lib/opencode/auth-state-runtime.js';
import { createProjectDirectoryRuntime } from './lib/projects/project-directory-runtime.js';
import { createSettingsNormalizationRuntime } from './lib/settings/settings-normalization-runtime.js';
import { createSettingsHelpers, isMessageSearchEnabled } from './lib/settings/settings-helpers.js';
import { createThemeRuntime } from './lib/appearance/theme-runtime.js';
import { createFeatureRoutesRuntime } from './lib/server-frame/feature-routes-runtime.js';
import { createPluginSwitchStore } from './lib/opencode/plugin-switches.js';
import { parseServeCliOptions } from './lib/server-frame/cli-options.js';
import {
  isRequestAuthorized,
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/server-frame/core-routes.js';
import { registerOpenChamberRoutes } from './lib/self-update/openchamber-routes.js';
import { createServerUtilsRuntime } from './lib/server-frame/server-utils-runtime.js';
import { createMcpOAuthSignIn } from './lib/opencode/mcp-oauth.js';
import { getMcpConfig, listMcpConfigs, updateMcpConfig } from './lib/opencode/mcp.js';
import { createOpenCodeTrust } from './lib/opencode-trust/index.js';
import { registerSessionProjectRoutes } from './lib/projects/session-directory.js';
import { guardOpenCodeFetch } from './lib/opencode-trust/fetch-guard.js';
import { createStaticRoutesRuntime } from './lib/server-frame/static-routes-runtime.js';
import { createSettingsRuntime } from './lib/settings/settings-runtime.js';
import { createOpenCodeResolutionRuntime } from './lib/opencode/opencode-resolution-runtime.js';
import { runOpenCodeCliUpgrade } from './lib/opencode/cli-upgrade.js';
import { resolveOpenCodeUpgradeCapability } from './lib/opencode/upgrade-capability.js';
import { createBootstrapRuntime } from './lib/server-frame/bootstrap-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { configureOpenCodeRuntimeProviders, resetOpenCodeRuntimeProviders } from './lib/small-model/client.js';
import { configureOpenCodeCredentials, openCodeCredentialSource } from './lib/opencode/auth.js';
import { configureProjectStartCommandSource, openCodeProjectStartCommandSource } from './lib/opencode/project-start-command.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { createTurnStartReader } from './lib/opencode/turn-start.js';
import { createSessionActivityProbe } from './lib/opencode/session-activity.js';
import { createSessionAssistRuntime } from './lib/session-assist/runtime.js';
import { createSessionGoalRuntime } from './lib/session-goal/runtime.js';
import { createGoalPersistence } from './lib/session-goal/interruption.js';
import { createContextObligatoryRuntime } from './lib/context-obligatory/runtime.js';
import { createSessionWarmingRuntime } from './lib/session-warming/runtime.js';
import { createSessionTodosRuntime } from './lib/session-todos/runtime.js';
import { isSpaceDirectory } from './lib/spaces/dispatcher.js';
import { createTrackerRegistry } from './lib/trackers/registry.js';
import { createTrackerSessionStatus } from './lib/trackers/session-status.js';
import { sourceControlProviderDescriptors } from './lib/source-control/provider-descriptors.js';
import { measureMemoryIndex } from './lib/session-knowledge/runtime.js';
import { createManagedSessionKnowledgeRuntime } from './lib/session-knowledge/managed-runtime.js';
import { createSessionLeadServer } from './lib/session-lead/server.js';
import { createMemoryDreaming } from './lib/agent-memory/dreaming.js';
import { isAutoModel, JEV_BACKGROUND_TIMEOUT_MS } from './lib/routing/defaults.js';
import { createMessageSearchRuntime } from './lib/message-search/runtime.js';
import { applyOwnedArchiveState } from './lib/opencode/proxy.js';
import { createScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import type { ProjectScheduledTasksRuntime } from './lib/scheduled-tasks/runtime.js';
import { createSuggestedTasksRuntime } from './lib/suggested-tasks/runtime.js';
import { createBotsHost, createBotChildServer } from './lib/bots/host.js';
import { createMcpToolsRuntime } from './lib/mcp-tools/runtime.js';
import { createSuggestionStore } from './lib/suggested-tasks/store.js';
import { createReadSessionDefaults, resolveSessionDefaults } from './lib/scheduled-tasks/session-defaults.js';
import { createChatsScope } from './lib/scheduled-tasks/chats-scope.js';
import { createChatDirectoryCleanupRuntime } from './lib/chat-directories/runtime.js';
import { createUnregisteredScheduledWorktreeBridge } from './lib/scheduled-tasks/worktree-bridge.js';
import { createServerStartupRuntime } from './lib/server-frame/server-startup-runtime.js';
import { createTunnelWiringRuntime } from './lib/tunnels/tunnel-wiring-runtime.js';
import { createStartupPipelineRuntime } from './lib/server-frame/startup-pipeline-runtime.js';
import { createHiddenSessionRegistry } from './lib/opencode/hidden-sessions.js';
import { runCliEntryIfMain } from './lib/server-frame/cli-entry-runtime.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationEmitterRuntime } from './lib/notifications/emitter-runtime.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createAppVersionMarker, createNotificationCenterPersistence, createNotificationCenterRuntime } from './lib/notifications/center.js';
import { getCurrentVersion as getInstalledOpenChamberVersion } from './lib/package-manager.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createApnsRuntime } from './lib/notifications/apns-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
import { createPermissionAutoAcceptRuntime } from './lib/permission-auto-accept/runtime.js';
import { createMessageQueueRuntime } from './lib/message-queue/runtime.js';
import { createBotConversationQueue, registerBotConversationGuards } from './lib/bots/conversation-queue.js';
import { createBotSessionDefaults } from './lib/bots/session-defaults.js';
import { botConversationDeliveryFetch } from './lib/bots/conversation-delivery.js';
import { createFixLoopRuntime } from './lib/pr-fix-loop/runtime.js';
import { createFixLoopHostAdapters, type FixLoopClient } from './lib/pr-fix-loop/host-adapters.js';
import { requireLocalRuntime } from './lib/server-frame/local-runtime.js';
import { createSpaceWorker } from './lib/pr-fix-loop/space-worker.js';
import { createApprovalPublication } from './lib/pr-fix-loop/publication.js';
import { createHostGit } from './lib/spaces/host-git.js';
import { runCommand as runSpaceCommand } from './lib/spaces/run-command.js';
import { unwrapOpenCodeResponse } from './lib/opencode/response-envelope.js';
import { createTokenSnapshotReader } from './lib/pr-fix-loop/token-usage.js';
import { createRestackRuntime } from './lib/pr-stacks/restack.js';
import type { RestackRun } from './lib/pr-stacks/restack-contracts.js';
import { createAutoReviewRuntime } from './lib/auto-review/runtime.js';
import { createAutomationAdmission, sessionKey } from './lib/session-automation/runtime.js';
import type { AutomationClaim } from './lib/session-automation/runtime.js';
import { createDispatchResultsRuntime } from './lib/dispatch-results/runtime.js';
import { createPrWatchRuntime } from './lib/pr-watch/runtime.js';
import { createExtensionWaitsRuntime } from './lib/extension-waits/runtime.js';
import { createLaterPages } from './lib/openchamber-control/later-pages.js';
import { createMergeFollowRuntime } from './lib/github/merge-follow.js';
import { createWorkflowAgentSessions } from './lib/workflows/agent-session.js';
import { createWorkflowRuntime, lightenWorkflowRun } from './lib/workflows/runtime.js';
import { createWorkflowRunStore } from './lib/workflows/store.js';
import { createSharePagesRuntime } from './lib/share-pages/runtime.js';
import { createSharePageStore } from './lib/share-pages/store.js';
import {
  createRelayShareSigner,
  createShareRelayClient,
  createShareViewerClient,
  isRelayBaseAllowed,
  isSharingAvailable,
  resolveShareRelayBase,
} from './lib/share-pages/relay-client.js';
import { allowedReceiveBases } from './lib/share-pages/received-link.js';
import { createReceivedPagesRuntime } from './lib/share-pages/received-runtime.js';
import { createReceivedPageStore } from './lib/share-pages/received-store.js';
import { registerReceivedPageRoutes, registerSharePageRoutes } from './lib/share-pages/routes.js';
import { createRoutingRuntime } from './lib/routing/runtime.js';
import { createJevClient } from './lib/routing/jev.js';
import { createSessionWorkRuntime } from './lib/session-work/runtime.js';
import { createSessionInterruptionRuntime } from './lib/session-interruption/runtime.js';
import { restartInterruptedNotification } from './lib/session-interruption/restart.js';
import { OpenCode } from '@opencode/client';
import { createAutoResumeRuntime } from './lib/session-interruption/auto-resume.js';
import { readCgroupMemory } from './lib/opencode/cgroup-memory.js';
import { createSessionLineage } from './lib/session-lineage.js';
import { createGracefulShutdownRuntime } from './lib/server-frame/shutdown-runtime.js';
import { beginGuestServiceHost, beginGuestServiceShutdown, getServiceStatus, holdGuestService, onGuestServiceEnded, proxyGuestServiceRequest, refreshServerBrowserOrigins, stopAllGuestServices } from './lib/guests/service.js';
import { serverBrowserOrigins } from './lib/guests/server-browser-config.js';
import { guestMarks } from './lib/guests/marks.js';
import { guestServiceRegistryDir } from './lib/guests/service-registry.js';
import { findInstalledGuest, listInstalledGuests, setGuestConfigurationNote } from './lib/guests/catalog.js';
import { createExtensionSessionEvents } from './lib/guests/session-events.js';
import { createGuestAgentContext } from './lib/guests/agent-context.js';
import { getGuestAuth, guestAuthPersistPath } from './lib/guests/auth-store.js';
import { createGuestInstructions } from './lib/guests/instructions.js';
import { createServiceHostApi } from './lib/guests/service-host-api.js';
import { createServiceLifetime } from './lib/guests/service-lifetime.js';
import { extensionsPersistPath } from './lib/guests/persist.js';
import { createGuestSurfaceRuntime } from './lib/guests/surface.js';
import { BROWSER_PROVIDER_IDLE_MS, NOTIFICATIONS_OUTBOUND_PATH } from '@openchamber/sdk';
import { setHostCallbackRoute } from './lib/guests/host-callback.js';
import { createOutboundHandles } from './lib/source-control/outbound-handles.js';
import { createNotificationChannelAccounts, notificationChannelsPersistPath } from './lib/notifications/channel-accounts.js';
import { createExtensionNotificationChannels } from './lib/notifications/extension-channels.js';
import { createProjectConfigRuntime } from './lib/projects/project-config.js';
import { ensureChatsDir, migrateLegacyUserDirs } from './lib/data-dir-migration.js';
import { createProjectContextRuntime } from './lib/project-context/runtime.js';
import { createAgentMemoryRuntime } from './lib/agent-memory/runtime.js';
import { createAgentMemoryActions } from './lib/agent-memory/actions.js';
import { createMemoryProjectResolver } from './lib/agent-memory/project-resolution.js';
import { createSpacesHost } from './lib/spaces/host.js';
import { createSpaceArchive } from './lib/spaces/space-archive.js';
import { readIdleStopSetting, startIdleStop } from './lib/spaces/idle-stop.js';
import { permissionDefaultOf, readSpacePermissionDefault } from './lib/spaces/space-permission-default.js';
import { createInsideSpaceTaskNaming, SPACE_TASK_TITLE_ROUTE } from './lib/spaces/task-title.js';
import { dockerHostOf } from './lib/spaces/places/ssh-host.js';
import { SPACE_IDLE_EXIT_CODE } from './lib/spaces/layout.js';
import { createSwitchController, registerSpaceRoutes } from './lib/spaces/routes.js';
import { addDetachedWorktree, getCheckedOutBranch, getRepositoryRemoteUrls, getWorktreeBootstrapGateStatus, getWorktrees, isWorktreeDirectoryPinned, listChangedPathsSince, readScanCheckout, readRenameableGeneratedBranch, removeDetachedWorktree, renameGeneratedWorktreeBranch, resolvePrimaryWorktreeRoot, runGitCommandNoEditor, setWorktreeTaskTitle } from './lib/git/service.js';
import { getLinearAuth } from './lib/linear/auth.js';
import { createEnvironmentStore } from './lib/environment/store.js';
import { composeEnvironmentRuntime } from './lib/environment/composition.js';
import { readOpenCodeServiceEnv } from './lib/environment/opencode-service-env.js';
import { OPENCODE_CONFIG_DIR } from './lib/opencode/config-files.js';
import { createWorktreeBootstrapStore } from './lib/git/worktree-bootstrap-storage.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { createClientPushAccess } from './lib/notifications/client-push-access.js';
import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { attachRealtimeProxy } from './lib/realtime-proxy.js';
import { createRelayService, relayBlockedByEnterprise } from './lib/relay/service.js';
import { createRelayHostLock } from './lib/relay/host-lock.js';
import { createRelayKeyStore } from './lib/relay/key-store.js';
import { createAgentToolRuntime } from './lib/agent-tool/runtime.js';
import { createBrowserControlBroker } from './lib/browser-control/broker.js';
import { createBrowserClientEvents } from './lib/browser-control/client-events.js';
import { createBrowserControlRouter } from './lib/browser-control/provider.js';
import { createDevServerScanner } from './lib/dev-servers/routes.js';
import { createDevTunnelRuntime } from './lib/dev-tunnel/runtime.js';
import { registerBrowserControlRoutes } from './lib/browser-control/routes.js';
import { createUploadStore, registerUploadRoute } from './lib/browser-control/uploads.js';
import { createManagedConfigRuntime, retireClaudePlugin } from './lib/opencode/managed-config-file.js';
import { createSharedOpenCodeServiceConnector, resolveServiceCliBinary } from './lib/opencode/shared-service.js';
import { createAdaptivePluginSwitchStore, createGlobalConfigPluginSwitchStore } from './lib/opencode/global-plugin-switches.js';
import { openCodePluginDelivery } from './lib/guests/opencode-plugin.js';
import { createLimitFailoverRuntime } from './lib/limit-failover/runtime.js';
import { prepareInstanceDir } from './lib/opencode/instance-dir.js';
import { createOpenChamberSessionService } from './lib/openchamber-sessions/routes.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata } from './lib/openchamber-sessions/session-metadata-store.js';
import { createUnreadBaseline } from './lib/openchamber-sessions/unread-baseline.js';
import { createTurnDurationRecorder } from './lib/openchamber-sessions/turn-duration.js';
import { createOpenCodeClient } from './lib/openchamber-sessions/opencode-client.js';
import { createScheduledTaskService } from './lib/scheduled-tasks/service.js';
import { createModelCatalogReader } from './lib/scheduled-tasks/model-catalog.js';
import { createOpenChamberControlService } from './lib/openchamber-control/service.js';
import { createPluginNotificationEmitter } from './lib/notifications/emit-route.js';
import { OpenChamberControlError } from './lib/openchamber-control/error.js';
import { createSessionLinker } from './lib/openchamber-sessions/session-link.js';
import { createFileOpenRequester } from './lib/openchamber-control/file-open.js';
import { createSavedSecrets, createSecretFiles } from './lib/openchamber-control/secret-request.js';
import { applyConnectAttemptTimeout } from './lib/network-defaults.js';
import { applyOutboundProxyFromEnv } from './lib/outbound-proxy.js';
import { applyForkReleaseSource } from './lib/fork-identity.js';
import { applySystemCertificates } from './lib/system-ca.js';
import { readOpenCodeLoad } from './lib/diagnostics/opencode-load.js';
import type { OpenCodeLifecycleState } from './lib/opencode/lifecycle.js';
import type { OpenCodeEnvState } from './lib/opencode/env-runtime.js';
import type { TunnelWiringDependencies } from './lib/tunnels/tunnel-wiring-runtime.js';
import type { Request, Response } from './lib/shared/http-contracts.js';
import type { StreamSocket } from './lib/event-stream/contracts.js';
import type { ScheduledTaskEventClient } from './lib/scheduled-tasks/routes.js';
import type { MetadataDecider, MetadataReadOptions, SessionMetadata } from './lib/openchamber-sessions/session-metadata-store.js';
import { isBoolean, isRecord, isString } from './lib/shared/object-guards.js';
import type { JsonValue } from './lib/shared/json-values.js';
import type { ForwardEventPayload } from './lib/event-stream/contracts.js';
import type { TranslatedEvent } from './lib/event-stream/translate-v2.js';
import type { SessionCreatedEvent } from './lib/openchamber-sessions/routes.js';
import type { MemoryChangedEvent } from './lib/agent-memory/contracts.js';
import type { BrowserProviderReset } from './lib/browser-control/provider.js';
import type { ControlInput, SessionReadAction, SessionReadResults } from './lib/openchamber-control/contracts.js';
import type { ControlOptions, SessionActionResult } from './lib/openchamber-control/service.js';
import { readAgentServerMode, createAgentTunnelContext } from './lib/agent-server/mode.js';
import { asNonEmptyString } from './lib/shared/guards.js';
import { createAgentUpstream } from './lib/agent-server/agent-upstream.js';
import { classify, normalizedRequestUrl } from './lib/agent-server/ownership.js';
import { createFrontDoor, frontDoorRequestGate } from './lib/agent-server/front-door.js';
import { createAgentStreams } from './lib/agent-server/agent-streams.js';
import { createFrontDoorTrackedItems } from './lib/agent-server/tracked-items.js';
import { createSettingsMirror } from './lib/agent-server/settings-mirror.js';
import { createProjectRegistry, sanitizeRegistryProjects } from './lib/agent-server/project-registry.js';
import { createHostdClient } from './lib/hostd/client.js';
import { trustMigratedBotCheckout, trustProjectRepositories } from './lib/agent-server/git-trust.js';
import { registerDisplayMetadataRoute, readAgentDisplayMetadata } from './lib/agent-server/display-metadata.js';
import { registerAgentProtectedMcpRoutes, createProtectedMcpMirror, AGENT_PROTECTED_MCP_ROUTE } from './lib/agent-server/protected-mcp.js';
import { registerSpaceTransferRoutes } from './lib/agent-server/space-transfer-routes.js';
import { createAgentFixLoopServices } from './lib/agent-server/fix-loop-services.js';
import { registerFixLoopServiceRoutes } from './lib/agent-server/fix-loop-service-routes.js';
import { assertAgentBotWatchAvailable, createFrontDoorFixLoopAdmission, registerFrontDoorFixLoopRoutes } from './lib/agent-server/front-door-fix-loops.js';
import { createAgentHeadTransfer } from './lib/pr-fix-loop/agent-head-transfer.js';
import { registerHostCredentialRoutes } from './lib/agent-server/host-credential-routes.js';
import { createAgentHostCredentials } from './lib/agent-server/host-credentials.js';
import { createAgentCredentialSource } from './lib/agent-server/credential-source.js';
import { createAgentBotServices } from './lib/agent-server/bot-services.js';
import { createBotExecutionServices, registerBotServiceRoutes } from './lib/agent-server/bot-service-routes.js';
import { createOwnerBotConfig } from './lib/bots/owner-config.js';
import type { MigrationRequest } from './lib/bots/production-worktree-contracts.js';

type BootstrapResult = ReturnType<ReturnType<typeof createBootstrapRuntime>['setupBaseRoutes']>;
type StartupPipelineInput = Parameters<ReturnType<typeof createStartupPipelineRuntime>['run']>[0];
type StartupPipelineResult = Awaited<ReturnType<ReturnType<typeof createStartupPipelineRuntime>['run']>>;
type BootstrapInput = Parameters<ReturnType<typeof createBootstrapRuntime>['setupBaseRoutes']>[1];

interface ScheduledTaskRanProperties {
  projectId: string;
  taskId: string;
  ranAt: number;
  status: string;
  sessionId?: string;
}

interface SessionCreatedProperties {
  sessionId: string;
  directory: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
  projectId?: string;
  title?: string;
}

interface WebUiServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  uiPassword?: string | null | undefined;
  uiPasswordHash?: string | null | undefined;
  shareProject?: NonNullable<Parameters<typeof createProjectRegistry>[0]>['shareProject'];
  ownsProject?: NonNullable<Parameters<typeof createProjectRegistry>[0]>['ownsProject'];
  tryCfTunnel?: boolean | undefined;
  apiOnly?: boolean | undefined;
  tunnelMode?: string | undefined;
  tunnelProvider?: string | undefined;
  tunnelConfigPath?: string | null | undefined;
  tunnelToken?: string | undefined;
  tunnelHostname?: string | undefined;
  attachSignals?: boolean | undefined;
  exitOnShutdown?: boolean | undefined;
  onTunnelReady?: StartupPipelineInput['onTunnelReady'] | undefined;
  onDesktopNotification?: Parameters<ReturnType<typeof createNotificationEmitterRuntime>['setOnDesktopNotification']>[0] | undefined;
  getIsWindowFocused?: Parameters<ReturnType<typeof createNotificationTriggerRuntime>['setGetIsWindowFocused']>[0] | undefined;
  getDesktopRuntimeConfig?: Parameters<typeof attachRealtimeProxy>[0]['getDesktopRuntimeConfig'] | undefined;
  desktopUpdater?: BootstrapInput['desktopUpdater'] | undefined;
  builtInExtensionsDir?: string | undefined;
}

applyConnectAttemptTimeout();
applySystemCertificates();
applyOutboundProxyFromEnv();
applyForkReleaseSource();

const serverMode = readAgentServerMode();
const { frontDoor: FRONT_DOOR, agent: AGENT_SERVER } = serverMode;
const agentUpstream = FRONT_DOOR ? createAgentUpstream(serverMode.upstream) : null;
const frontDoorTrackedItems = agentUpstream ? createFrontDoorTrackedItems({ upstream: agentUpstream }) : null;
let frontDoorListen: { readonly port: number; readonly host: string } | null = null;
const frontDoorOrigins = (settings: Awaited<ReturnType<typeof readSettingsFromDiskMigrated>>) => {
  if (!frontDoorListen) throw new Error('front_door_origins_unknown');
  const { port, host } = frontDoorListen;
  const address = server?.address();
  const listening = serverBrowserOrigins({
    settingsOrigins: Array.isArray(settings.serverBrowserOpenChamberOrigins) ? settings.serverBrowserOpenChamberOrigins : [],
    port: address && !isString(address) ? address.port : port,
    host,
    addresses: ['0.0.0.0', '::'].includes(host)
      ? Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address))
      : [],
  });
  const configuredOrigin = asNonEmptyString(settings.publicOrigin);
  let publicOrigin: string | null = null;
  try { publicOrigin = configuredOrigin ? new URL(configuredOrigin).origin : null; } catch { publicOrigin = null; }
  return [...new Set([...listening, ...(publicOrigin && /^https?:/.test(publicOrigin) ? [publicOrigin] : [])])];
};
const settingsMirror = agentUpstream ? createSettingsMirror({ upstream: agentUpstream, ownOrigins: async (settings) => frontDoorOrigins(settings) }) : null;
const trustAgentProjects = async (settings: Awaited<ReturnType<typeof readSettingsFromDiskMigrated>>) => {
  const projects = Array.isArray(settings.projects) ? settings.projects : [];
  try {
    await trustProjectRepositories({
      projects,
      runGit: (args) => runSpaceCommand(resolveGitBinaryForSpawn(), args, { timeoutMs: 10_000 }),
    });
  } catch (error) {
    console.warn(`[agent-server] the projects' repositories were not trusted: ${isRecord(error) ? error.code ?? 'git_failed' : 'git_failed'}`);
  }
};
let projectRegistry = createProjectRegistry();
let frontDoorRuntime: ReturnType<typeof createFrontDoor> | null = null;
let agentStreams: ReturnType<typeof createAgentStreams> | null = null;

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set<Response>();
const uiNotificationWsClients = new Set<StreamSocket>();
const uiOpenChamberEventClients = new Set<ScheduledTaskEventClient>();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = resolveProxyRequestTimeoutMs({
  OPENCHAMBER_PROXY_TIMEOUT_MS: process.env.OPENCHAMBER_PROXY_TIMEOUT_MS,
}, console);

const isNumber = (value: unknown): value is number => typeof value === 'number';
const isCallback = <Callback extends (...args: never[]) => void>(value: Callback | null | undefined): value is Callback => typeof value === 'function';

function headerIncludesEventStream(value: string | number | readonly string[] | undefined) {
  if (isString(value)) {
    return value.toLowerCase().includes('text/event-stream');
  }

  if (Array.isArray(value)) {
    return value.some((entry) => isString(entry) && entry.toLowerCase().includes('text/event-stream'));
  }

  return false;
}

const SSE_PATH_PREFIXES = [
  '/api/event',
  '/api/global/event',
  '/api/notifications/stream',
  '/api/openchamber/events',
  '/api/openchamber/realtime-proxy/sse',
];

function shouldSkipCompression(req: Request, res: Response) {
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  if (headerIncludesEventStream(req.headers.accept)) {
    return true;
  }

  const pathname = req.path || req.url || '';
  if (/^\/api\/guests\/[^/]+\/loopback(?:\/|$)/.test(pathname)) return true;
  if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
    return true;
  }

  for (const prefix of SSE_PATH_PREFIXES) {
    if (pathname === prefix) {
      return true;
    }
  }

  return headerIncludesEventStream(res.getHeader('Content-Type'));
}

const OPENCHAMBER_VERSION = (() => {
  try {
    const packagePath = webPackagePaths.packageJson;
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg: unknown = JSON.parse(raw);
    if (isRecord(pkg) && isString(pkg.version) && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
})();

const isEnvFlagEnabled = (value: string | boolean | number | undefined) => {
  if (value === true || value === 1) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const isEnvFlagDisabled = (value: string | boolean | number | undefined) => {
  if (value === false || value === 0) return true;
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'false';
};

const shouldSkipApiCompression = () => {
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_SKIP_API_COMPRESSION)) return true;
  if (isEnvFlagEnabled(process.env.OPENCHAMBER_COMPRESS_API)) return false;
  if (isEnvFlagDisabled(process.env.OPENCHAMBER_COMPRESS_API)) return true;
  return process.env.OPENCHAMBER_RUNTIME === 'desktop';
};

const OPENCHAMBER_VERBOSE_REQUEST_LOGS = isEnvFlagEnabled(process.env.OPENCHAMBER_VERBOSE_REQUEST_LOGS);

const fsPromises = fs.promises;

const settingsNormalizationRuntime = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  realpathSync: FRONT_DOOR ? undefined : fs.realpathSync,
  readdirSync: FRONT_DOOR ? undefined : fs.readdirSync,
});

const normalizeDirectoryPath: typeof settingsNormalizationRuntime.normalizeDirectoryPath = (...args) => settingsNormalizationRuntime.normalizeDirectoryPath(...args);
const normalizePathForPersistence: typeof settingsNormalizationRuntime.normalizePathForPersistence = (...args) => settingsNormalizationRuntime.normalizePathForPersistence(...args);
const normalizeSettingsPaths: typeof settingsNormalizationRuntime.normalizeSettingsPaths = (...args) => settingsNormalizationRuntime.normalizeSettingsPaths(...args);
const normalizeTunnelBootstrapTtlMs: typeof settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelBootstrapTtlMs(...args);
const normalizeTunnelSessionTtlMs: typeof settingsNormalizationRuntime.normalizeTunnelSessionTtlMs = (...args) => settingsNormalizationRuntime.normalizeTunnelSessionTtlMs(...args);
const normalizeManagedRemoteTunnelHostname: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelHostname(...args);
const normalizeManagedRemoteTunnelPresets: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresets(...args);
const normalizeManagedRemoteTunnelPresetTokens: typeof settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens = (...args) =>
  settingsNormalizationRuntime.normalizeManagedRemoteTunnelPresetTokens(...args);
const isUnsafeSkillRelativePath: typeof settingsNormalizationRuntime.isUnsafeSkillRelativePath = (...args) => settingsNormalizationRuntime.isUnsafeSkillRelativePath(...args);
const normalizeStringArray: typeof settingsNormalizationRuntime.normalizeStringArray = (...args) => settingsNormalizationRuntime.normalizeStringArray(...args);
const sanitizeModelRefs: typeof settingsNormalizationRuntime.sanitizeModelRefs = (...args) => settingsNormalizationRuntime.sanitizeModelRefs(...args);
const sanitizeSkillCatalogs: typeof settingsNormalizationRuntime.sanitizeSkillCatalogs = (...args) => settingsNormalizationRuntime.sanitizeSkillCatalogs(...args);
const sanitizeProjects: typeof settingsNormalizationRuntime.sanitizeProjects = (...args) => FRONT_DOOR ? sanitizeRegistryProjects(...args) : settingsNormalizationRuntime.sanitizeProjects(...args);
const sanitizeProjectList = (projects: Parameters<typeof sanitizeProjects>[0]) => sanitizeProjects(projects) ?? [];

const OPENCHAMBER_DEFAULT_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_CONFIG_ROOT = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : OPENCHAMBER_DEFAULT_CONFIG_ROOT;
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');
const OPENCHAMBER_PROJECTS_CONFIG_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'projects');
const OPENCHAMBER_CHATS_DIR = process.env.OPENCHAMBER_CHATS_DIR && process.env.OPENCHAMBER_CHATS_DIR.trim()
  ? path.resolve(process.env.OPENCHAMBER_CHATS_DIR.trim())
  : path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats');

const MAX_THEME_JSON_BYTES = 512 * 1024;


const themeRuntime = createThemeRuntime({
  fsPromises,
  path,
  themesDir: OPENCHAMBER_USER_THEMES_DIR,
  maxThemeJsonBytes: MAX_THEME_JSON_BYTES,
  logger: console,
});

const readCustomThemesFromDisk: typeof themeRuntime.readCustomThemesFromDisk = (...args) => themeRuntime.readCustomThemesFromDisk(...args);
const saveImportedTheme: typeof themeRuntime.saveImportedTheme = (...args) => themeRuntime.saveImportedTheme(...args);
const deleteImportedTheme: typeof themeRuntime.deleteImportedTheme = (...args) => themeRuntime.deleteImportedTheme(...args);

let agentToolRuntime: ReturnType<typeof createAgentToolRuntime> | null = null;
let limitFailoverRuntime: ReturnType<typeof createLimitFailoverRuntime> | null = null;
let managedConfigRuntime: ReturnType<typeof createManagedConfigRuntime> | null = null;
let stopEnterprisePolicyWatch = () => {};

const resolveNotificationTemplate: typeof notificationTemplateRuntime.resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage: typeof notificationTemplateRuntime.shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels: typeof notificationTemplateRuntime.fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const extractLastMessageText: typeof notificationTemplateRuntime.extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchLastAssistantMessageText: typeof notificationTemplateRuntime.fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent: typeof notificationTemplateRuntime.maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables: typeof notificationTemplateRuntime.buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels: typeof notificationTemplateRuntime.getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

const OPENCHAMBER_DATA_DIR = OPENCHAMBER_USER_CONFIG_ROOT;
const protectedMcpMirror = agentUpstream ? createProtectedMcpMirror({ upstream: agentUpstream, dataDir: OPENCHAMBER_DATA_DIR }) : null;
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const pluginSwitchStore = createPluginSwitchStore({ filePath: path.join(OPENCHAMBER_DATA_DIR, 'plugin-switches.json') });
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const APNS_TOKENS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'apns-tokens.json');
const PUSH_OPEN_TAGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-open-tags.json');
const openCodeTrust = createOpenCodeTrust({
  storePath: path.join(OPENCHAMBER_DATA_DIR, 'opencode-trust.json'),
  listKnownDirectories: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
  },
});
if (!FRONT_DOOR) globalThis.fetch = guardOpenCodeFetch({
  fetchImpl: globalThis.fetch,
  openCodeTrust,
  buildOpenCodeUrl: (...args) => buildOpenCodeUrl(...args),
  getOpenCodeAuthHeaders: (...args) => getOpenCodeAuthHeaders(...args),
});
const REMOTE_CLIENTS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'remote-clients.json');
const CLIENT_PAIRING_SESSIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'client-pairing-sessions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 1;
const worktreeBootstrapStore = createWorktreeBootstrapStore({
  filePath: path.join(OPENCHAMBER_DATA_DIR, 'git-worktree-bootstrap.json'),
  fsImpl: fsPromises,
});

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  },
});

const readManagedRemoteTunnelConfigFromDisk: typeof managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets: typeof managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken: typeof managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken: typeof managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

const settingsHelpers = createSettingsHelpers({
  normalizePathForPersistence,
  normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  normalizeStringArray,
  sanitizeModelRefs,
  sanitizeSkillCatalogs,
  sanitizeProjects,
});

const normalizePwaAppName: typeof settingsHelpers.normalizePwaAppName = (...args) => settingsHelpers.normalizePwaAppName(...args);
const normalizePwaOrientation: typeof settingsHelpers.normalizePwaOrientation = (...args) => settingsHelpers.normalizePwaOrientation(...args);
const sanitizeSettingsUpdate: typeof settingsHelpers.sanitizeSettingsUpdate = (...args) => settingsHelpers.sanitizeSettingsUpdate(...args);
const mergePersistedSettings: typeof settingsHelpers.mergePersistedSettings = (...args) => settingsHelpers.mergePersistedSettings(...args);
const formatSettingsResponse: typeof settingsHelpers.formatSettingsResponse = (...args) => FRONT_DOOR ? settingsRuntime.formatSettingsResponse(...args) : settingsHelpers.formatSettingsResponse(...args);

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
  refuseDirectory: (candidate) => spacesHost?.refuseDirectory(candidate) ?? null,
});

const resolveDirectoryCandidate: typeof projectDirectoryRuntime.resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath: typeof projectDirectoryRuntime.validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory: typeof projectDirectoryRuntime.resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory: typeof projectDirectoryRuntime.resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  frontDoor: FRONT_DOOR,
  beforeProjectsSave: FRONT_DOOR ? (projects, currentProjects) => projectRegistry.beforeProjectsSave(projects, currentProjects) : undefined,
  onSettingsWritten: async (settings) => {
    await settingsMirror?.onSettingsWritten(settings);
    if (AGENT_SERVER) await trustAgentProjects(settings);
    if (!FRONT_DOOR) await refreshServerBrowserOrigins();
  },
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  normalizeStringArray,
  formatSettingsResponse: (...args) => settingsHelpers.formatSettingsResponse(...args),
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  onManagedPluginSettingsChanged: () => managedConfigRuntime?.refreshManagedConfigFile(),
  onMessageSearchEnabledChanged: (enabled) => messageSearchRuntime?.setEnabled(enabled),
  onMessageSearchReasoningChanged: (enabled) => messageSearchRuntime?.setReasoningEnabled(enabled),
  onPermissionDefaultModeChanged: (mode) => {
    void spacesHost?.journey.changePermissionDefault(mode).catch((error) => {
      console.warn(`[spaces] the default permission mode did not reach the running spaces: ${error?.code ?? error?.message ?? error}`);
    });
  },
  onLastDirectoryChanged: (directory) => {
    if (FRONT_DOOR) return;
    if (!isString(directory)) return;
    void openCodeTrust.isTrusted(directory).then((trusted) => {
      if (trusted) openCodeLifecycleRuntime.noteCurrentDirectory(directory);
    }, () => {});
  },
});

const readSettingsFromDiskMigrated: typeof settingsRuntime.readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk: typeof settingsRuntime.readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const readSettingsFromDiskStrict: typeof settingsRuntime.readSettingsFromDiskStrict = (...args) => settingsRuntime.readSettingsFromDiskStrict(...args);
const writeSettingsToDisk: typeof settingsRuntime.writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings: typeof settingsRuntime.persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
  allowLocalDevOrigins: allowsLocalDevOrigins(process.env),
});

const getUiSessionTokenFromRequest: typeof requestSecurityRuntime.getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  loadWebPush: () => import('web-push').then((module) => module.default),
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const getOrCreateVapidKeys: typeof pushRuntime.getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription: typeof pushRuntime.addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription: typeof pushRuntime.removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions: typeof pushRuntime.sendPushToAllUiSessions = (...args) => AGENT_SERVER ? Promise.resolve() : pushRuntime.sendPushToAllUiSessions(...args);
let clearPendingPushBadge = () => {};
const updateUiVisibility = (token: string, visible: boolean, platform?: string) => {
  if (visible === true) clearPendingPushBadge();
  return pushRuntime.updateUiVisibility(token, visible, platform);
};
const isAnyUiVisible: typeof pushRuntime.isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isAnyInteractiveClientVisible: typeof pushRuntime.isAnyInteractiveClientVisible = (...args) => pushRuntime.isAnyInteractiveClientVisible(...args);
const isUiVisible: typeof pushRuntime.isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized: typeof pushRuntime.ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized: typeof pushRuntime.setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

const relayKeyStore = createRelayKeyStore({
  fsPromises,
  path,
  dataDir: OPENCHAMBER_DATA_DIR,
  readSettingsFromDiskMigrated,
  readSettingsStrict: readSettingsFromDiskStrict,
  writeSettingsToDisk,
});

const apnsRuntime = createApnsRuntime({
  fsPromises,
  path,
  crypto,
  http2,
  APNS_TOKENS_FILE_PATH,
  readSettingsFromDiskMigrated,
  relayKeyStore,
  getInvalidSessionKeys: () => clientPushAccess.invalidSessionKeys(),
});

const addOrUpdateApnsToken: typeof apnsRuntime.addOrUpdateApnsToken = (...args) => apnsRuntime.addOrUpdateApnsToken(...args);
const removeApnsToken: typeof apnsRuntime.removeApnsToken = (...args) => apnsRuntime.removeApnsToken(...args);
const sendApnsToAllUiSessions: typeof apnsRuntime.sendApnsToAllUiSessions = (...args) => apnsRuntime.sendApnsToAllUiSessions(...args);
const clearApnsNotifications: typeof apnsRuntime.clearApnsNotifications = (...args) => apnsRuntime.clearApnsNotifications(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade: typeof requestSecurityRuntime.rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed: typeof requestSecurityRuntime.isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const notificationEmitterRuntime = createNotificationEmitterRuntime({
  process,
  getDesktopNotifyEnabled: () => ENV_DESKTOP_NOTIFY,
  desktopNotifyPrefix: DESKTOP_NOTIFY_PREFIX,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenChamberEventClients: () => uiOpenChamberEventClients,
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
});

const writeSseEvent: typeof notificationEmitterRuntime.writeSseEvent = (...args) => notificationEmitterRuntime.writeSseEvent(...args);
const emitDesktopNotification: typeof notificationEmitterRuntime.emitDesktopNotification = (...args) => notificationEmitterRuntime.emitDesktopNotification(...args);
const broadcastGlobalUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiNotificationClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});
const broadcastUiNotification: typeof notificationEmitterRuntime.broadcastUiNotification = (...args) => notificationEmitterRuntime.broadcastUiNotification(...args);

const broadcastOpenChamberUiEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: uiNotificationWsClients,
  writeSseEvent,
});

const broadcastControlSseEvent = createGlobalUiEventBroadcaster({
  sseClients: uiOpenChamberEventClients,
  wsClients: new Set(),
  writeSseEvent,
});
const broadcastPermissionUiEvent = <Payload>(payload: Payload) => {
  broadcastControlSseEvent(payload);
  broadcastGlobalUiEvent(payload);
};

const sessionMetadataStore = createSessionMetadataStore({
  dataDir: OPENCHAMBER_DATA_DIR,
  openCode: {
    read: (...args) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).read(...args),
    write: (sessionID, metadata, options) => createOpenCodeSessionMetadata({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).write(sessionID, metadata, options).then(() => {
      if (sessionLineage.noteMetadata(sessionID, metadata)) permissionAutoAcceptRuntime?.forgetSession(sessionID);
    }),
  },
});

const readStoredSessionMetadata = (sessionID: string | null, options?: MetadataReadOptions) => sessionMetadataStore.get(sessionID, options);

const settlePendingQuestionNotifications = (sessionID: string, patch: SessionMetadata | null) => {
  if (!isRecord(patch?.openchamber) || patch.openchamber.pendingQuestion !== null) return;
  void notificationCenter.resolve({ sessionId: sessionID, kinds: ['question'] }).catch((error) => {
    console.warn('[notification-center] could not resolve a settled question:', error?.message ?? error);
  });
};

const persistSessionMetadataPatch = async (sessionID: string, patch: SessionMetadata, { directory = '' }: { directory?: string | undefined } = {}) => {
  const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
  settlePendingQuestionNotifications(sessionID, patch);
  broadcastOpenChamberUiEvent({
    type: 'openchamber:session-metadata',
    properties: { sessionID, metadata },
  });
  if (sessionGoalRuntime && isRecord(patch.openchamber) && 'goal' in patch.openchamber) {
    void Promise.resolve(sessionGoalRuntime.notifyGoalChanged(sessionID, directory, metadata))
      .catch((error) => console.warn('[session-goal] could not arm after a goal change:', error?.message ?? error));
  }
  return metadata;
};

const updateSessionMetadataWith = async (sessionID: string, decide: MetadataDecider, { directory = '' }: { directory?: string | undefined } = {}) => {
  let decided: ReturnType<MetadataDecider> = null;
  const result = await sessionMetadataStore.updateSessionMetadata(sessionID, (metadata) => {
    decided = decide(metadata);
    return decided;
  }, { directory });
  if (result.changed) settlePendingQuestionNotifications(sessionID, decided);
  if (result.changed) {
    broadcastOpenChamberUiEvent({
      type: 'openchamber:session-metadata',
      properties: { sessionID, metadata: result.metadata },
    });
  }
  return result;
};

const sessionRuntime = createSessionRuntime({
  writeSseEvent,
  getNotificationClients: () => uiNotificationClients,
  broadcastEvent: broadcastGlobalUiEvent,
  readTurnStart: FRONT_DOOR ? null : (sessionId) => createTurnStartReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).readTurnStart(sessionId),
  buildOpenCodeUrl: (...args) => buildOpenCodeUrl(...args),
  getOpenCodeAuthHeaders: () => getOpenCodeAuthHeaders(),
  acquireRestartResume: async (sessionId) => {
    if (!automationAdmission) return null;
    await automationAdmission.ready();
    return automationAdmission.trySend(null, [sessionKey(sessionId)]);
  },
});

const getActiveSessionCount = () => sessionRuntime.getActiveSessionCount();

const getUpstreamStallTimeoutMs = () => (
  getActiveSessionCount() > 1
    ? UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS
    : DEFAULT_UPSTREAM_STALL_TIMEOUT_MS
);

const movedUserDirs = await migrateLegacyUserDirs({
  fsPromises,
  path,
  dataDir: OPENCHAMBER_USER_CONFIG_ROOT,
  legacyRoot: OPENCHAMBER_DEFAULT_CONFIG_ROOT,
  warn: (message) => console.warn(`[data-dir] ${message}`),
});
if (movedUserDirs.length > 0) {
  console.log(`[data-dir] Copied ${movedUserDirs.join(', ')} into ${OPENCHAMBER_USER_CONFIG_ROOT}`);
}

const projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime> | null = FRONT_DOOR ? null : createProjectConfigRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  switchNotesTodosStorage: (projectId, change) => {
    if (!projectContextRuntime) throw new Error('Project context is unavailable on the front door');
    return projectContextRuntime.switchNotesTodosStorage(projectId, change);
  },
});

const projectContextRuntime: ReturnType<typeof createProjectContextRuntime> | null = FRONT_DOOR ? null : createProjectContextRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  resolveSharedPlansDir: async (projectId) => {
    if (!projectConfigRuntime) throw new Error('Project configuration is unavailable on the front door');
    return projectConfigRuntime.resolveSharedPlansDir(projectId);
  },
  resolveNotesTodosFile: async (projectId) => {
    if (!projectConfigRuntime) throw new Error('Project configuration is unavailable on the front door');
    return projectConfigRuntime.resolveNotesTodosFile(projectId);
  },
  onChanged: (projectId) => broadcastOpenChamberUiEvent({
    type: 'openchamber:project-context-changed',
    properties: { projectId },
  }),
});

const agentMemoryRuntime = FRONT_DOOR ? null : createAgentMemoryRuntime({
  fsPromises,
  path,
  projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  userConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
});

const isAgentMemoryEnabled = async () => {
  const settings = await readSettingsFromDiskMigrated().catch(() => null);
  return settings?.agentMemoryToolEnabled === true;
};

const hmrStateRuntime = createHmrStateRuntime({
  globalThisLike: globalThis,
  os,
  processLike: process,
  stateKey: '__openchamberHmrState',
});
const hmrState = hmrStateRuntime.getOrCreateHmrState();
hmrStateRuntime.ensureUserProvidedOpenCodePassword(hmrState);

let healthCheckInterval: OpenCodeLifecycleState['healthCheckInterval'] = null;
let server: http.Server | null = null;
let expressApp: OpenCodeLifecycleState['expressApp'] = null;
let currentRestartPromise: OpenCodeLifecycleState['currentRestartPromise'] = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer: OpenCodeLifecycleState['openCodeApiDetectionTimer'] = null;
let lastOpenCodeError: OpenCodeLifecycleState['lastOpenCodeError'] = null;
let lastOpenCodeLaunchDiagnostics: OpenCodeLifecycleState['lastOpenCodeLaunchDiagnostics'] = null;
let lastOpenCodeHealthFailure: OpenCodeLifecycleState['lastOpenCodeHealthFailure'] = null;
let lastManagedOpenCodeProcess: OpenCodeLifecycleState['lastManagedOpenCodeProcess'] = null;
let lastOpenCodeRestartDiagnostics: OpenCodeLifecycleState['lastOpenCodeRestartDiagnostics'] = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let exitOnShutdown = true;
let uiAuthController: BootstrapResult['uiAuthController'] | null = null;
let spacesHost: Awaited<ReturnType<typeof createSpacesHost>> | null = null;
let spaceArchive: ReturnType<typeof createSpaceArchive> | null = null;
const isInsideBotSpace = Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE);
let botsHost: ReturnType<typeof createBotsHost> | null = null;
let botExecutionServices: ReturnType<typeof createBotExecutionServices> | null = null;
let botChildServer: ReturnType<typeof createBotChildServer> | null = null;
let activeTunnelController: ReturnType<TunnelWiringDependencies['getActiveTunnelController']> = null;
let globalWatcherStartPromise: ReturnType<typeof openCodeWatcherRuntime.start> | null = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
  createNgrokTunnelProvider(),
  createTailscaleTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname: string | undefined = '';
let terminalRuntime: StartupPipelineResult['terminalRuntime'] | null = null;
let dictationRuntime: StartupPipelineResult['dictationRuntime'] | null = null;
let guestSurfaceRuntime: ReturnType<typeof createGuestSurfaceRuntime> | null = null;
let realtimeProxyRuntime: ReturnType<typeof attachRealtimeProxy> | null = null;
let relayServiceInstance: ReturnType<typeof createRelayService> | null = null;
let relayReconcileTimer: ReturnType<typeof setInterval> | null = null;
let messageStreamRuntime: StartupPipelineResult['messageStreamRuntime'] | null = null;
const userProvidedOpenCodePassword = hmrStateRuntime.getUserProvidedOpenCodePassword(hmrState);
const initialOpenCodeAuthState = hmrStateRuntime.resolveOpenCodeAuthFromState({
  hmrState,
  userProvidedOpenCodePassword,
});
let openCodeAuthPassword = initialOpenCodeAuthState.openCodeAuthPassword;
let openCodeAuthSource = initialOpenCodeAuthState.openCodeAuthSource;

const syncToHmrState = () => {
  hmrStateRuntime.syncStateFromRuntime(hmrState, {
    openCodeProcess,
    openCodePort,
    openCodeBaseUrl,
    isShuttingDown,
    signalsAttached,
    openCodeWorkingDirectory,
    openCodeAuthPassword,
    openCodeAuthSource,
  });
};

const syncFromHmrState = () => {
  const restored = hmrStateRuntime.restoreRuntimeFromState({
    hmrState,
    userProvidedOpenCodePassword,
  });
  openCodeProcess = restored.openCodeProcess;
  openCodePort = restored.openCodePort;
  openCodeBaseUrl = restored.openCodeBaseUrl;
  isShuttingDown = restored.isShuttingDown;
  signalsAttached = restored.signalsAttached;
  openCodeWorkingDirectory = restored.openCodeWorkingDirectory;
  openCodeAuthPassword = restored.openCodeAuthPassword;
  openCodeAuthSource = restored.openCodeAuthSource;
};

let openCodeProcess = hmrState.openCodeProcess;
let openCodePort = hmrState.openCodePort;
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

const {
  configuredOpenCodePort: ENV_CONFIGURED_OPENCODE_PORT,
  configuredOpenCodeHost: ENV_CONFIGURED_OPENCODE_HOST,
  effectivePort: ENV_EFFECTIVE_PORT,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
} = resolveOpenCodeEnvConfig({
  env: process.env,
  logger: console,
});

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = (() => {
  if (process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true') {
    return true;
  }

  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return true;
  }

  const argv0 = isString(process.argv?.[0]) ? process.argv[0] : '';
  const argv1 = isString(process.argv?.[1]) ? process.argv[1] : '';
  return /openchamber-server/i.test(argv0) || /openchamber-server/i.test(argv1);
})();
const openCodeAuthStateRuntime = createOpenCodeAuthStateRuntime({
  crypto,
  process,
  getAuthPassword: () => openCodeAuthPassword,
  setAuthPassword: (value) => {
    openCodeAuthPassword = value;
  },
  getAuthSource: () => openCodeAuthSource,
  setAuthSource: (value) => {
    openCodeAuthSource = value;
  },
  getUserProvidedPassword: () => userProvidedOpenCodePassword,
  syncToHmrState,
});

const getOpenCodeAuthHeaders = (): Record<string, string> => FRONT_DOOR ? {} : openCodeAuthStateRuntime.getOpenCodeAuthHeaders();
const isOpenCodeConnectionSecure: typeof openCodeAuthStateRuntime.isOpenCodeConnectionSecure = (...args) => openCodeAuthStateRuntime.isOpenCodeConnectionSecure(...args);
const ensureLocalOpenCodeServerPassword: typeof openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword = (...args) => openCodeAuthStateRuntime.ensureLocalOpenCodeServerPassword(...args);

const openCodeNetworkState = {
  get openCodePort() { return openCodePort; },
  set openCodePort(value: typeof openCodePort) { openCodePort = value; },
  get openCodeBaseUrl() { return openCodeBaseUrl; },
  set openCodeBaseUrl(value: typeof openCodeBaseUrl) { openCodeBaseUrl = value; },
  get openCodeApiPrefix() { return openCodeApiPrefix; },
  set openCodeApiPrefix(value: typeof openCodeApiPrefix) { openCodeApiPrefix = value; },
  get openCodeApiPrefixDetected() { return openCodeApiPrefixDetected; },
  set openCodeApiPrefixDetected(value: typeof openCodeApiPrefixDetected) { openCodeApiPrefixDetected = value; },
  get openCodeApiDetectionTimer() { return openCodeApiDetectionTimer; },
  set openCodeApiDetectionTimer(value: typeof openCodeApiDetectionTimer) { openCodeApiDetectionTimer = value; },
};

const openCodeNetworkRuntime = createOpenCodeNetworkRuntime({
  state: openCodeNetworkState,
  getOpenCodeAuthHeaders,
  configuredOpenCodeHostname: ENV_CONFIGURED_OPENCODE_HOSTNAME,
});

const waitForReady: typeof openCodeNetworkRuntime.waitForReady = (...args) => openCodeNetworkRuntime.waitForReady(...args);
const normalizeApiPrefix: typeof openCodeNetworkRuntime.normalizeApiPrefix = (...args) => openCodeNetworkRuntime.normalizeApiPrefix(...args);
const setDetectedOpenCodeApiPrefix: typeof openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix(...args);
const buildOpenCodeUrl: typeof openCodeNetworkRuntime.buildOpenCodeUrl = (...args) => agentUpstream ? agentUpstream.buildUrl(args[0]) : openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const ensureOpenCodeApiPrefix: typeof openCodeNetworkRuntime.ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection: typeof openCodeNetworkRuntime.scheduleOpenCodeApiDetection = (...args) => { if (!FRONT_DOOR) return openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args); };

if (!FRONT_DOOR) configureOpenCodeRuntimeProviders({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getDefaultDirectory: () => openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(),
});

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let cachedLoginShellEnvSnapshot: OpenCodeEnvState['cachedLoginShellEnvSnapshot'];
let resolvedOpencodeBinary: Exclude<OpenCodeEnvState['resolvedOpencodeBinary'], undefined> = null;
let resolvedOpencodeBinarySource: OpenCodeEnvState['resolvedOpencodeBinarySource'] = null;
let resolvedNodeBinary: Exclude<OpenCodeEnvState['resolvedNodeBinary'], undefined> = null;
let resolvedBunBinary: Exclude<OpenCodeEnvState['resolvedBunBinary'], undefined> = null;
let resolvedGitBinary: Exclude<OpenCodeEnvState['resolvedGitBinary'], undefined> = null;
let useWslForOpencode: Exclude<OpenCodeEnvState['useWslForOpencode'], undefined> = false;
let resolvedWslBinary: Exclude<OpenCodeEnvState['resolvedWslBinary'], undefined> = null;
let resolvedWslOpencodePath: Exclude<OpenCodeEnvState['resolvedWslOpencodePath'], undefined> = null;
let resolvedWslDistro: Exclude<OpenCodeEnvState['resolvedWslDistro'], undefined> = null;

const openCodeEnvState = {
  get cachedLoginShellEnvSnapshot() { return cachedLoginShellEnvSnapshot; },
  set cachedLoginShellEnvSnapshot(value: typeof cachedLoginShellEnvSnapshot) { cachedLoginShellEnvSnapshot = value; },
  get resolvedOpencodeBinary() { return resolvedOpencodeBinary; },
  set resolvedOpencodeBinary(value: typeof resolvedOpencodeBinary) { resolvedOpencodeBinary = value; },
  get resolvedOpencodeBinarySource() { return resolvedOpencodeBinarySource; },
  set resolvedOpencodeBinarySource(value: typeof resolvedOpencodeBinarySource) { resolvedOpencodeBinarySource = value; },
  get resolvedNodeBinary() { return resolvedNodeBinary; },
  set resolvedNodeBinary(value: typeof resolvedNodeBinary) { resolvedNodeBinary = value; },
  get resolvedBunBinary() { return resolvedBunBinary; },
  set resolvedBunBinary(value: typeof resolvedBunBinary) { resolvedBunBinary = value; },
  get resolvedGitBinary() { return resolvedGitBinary; },
  set resolvedGitBinary(value: typeof resolvedGitBinary) { resolvedGitBinary = value; },
  get useWslForOpencode() { return useWslForOpencode; },
  set useWslForOpencode(value: typeof useWslForOpencode) { useWslForOpencode = value; },
  get resolvedWslBinary() { return resolvedWslBinary; },
  set resolvedWslBinary(value: typeof resolvedWslBinary) { resolvedWslBinary = value; },
  get resolvedWslOpencodePath() { return resolvedWslOpencodePath; },
  set resolvedWslOpencodePath(value: typeof resolvedWslOpencodePath) { resolvedWslOpencodePath = value; },
  get resolvedWslDistro() { return resolvedWslDistro; },
  set resolvedWslDistro(value: typeof resolvedWslDistro) { resolvedWslDistro = value; },
};

const openCodeEnvRuntime = createOpenCodeEnvRuntime({
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  providedLoginShellEnvSnapshot,
});

const applyLoginShellEnvSnapshot: typeof openCodeEnvRuntime.applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot: typeof openCodeEnvRuntime.getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const ensureOpencodeCliEnv: typeof openCodeEnvRuntime.ensureOpencodeCliEnv = (...args) => openCodeEnvRuntime.ensureOpencodeCliEnv(...args);
const applyOpencodeBinaryFromSettings: typeof openCodeEnvRuntime.applyOpencodeBinaryFromSettings = (...args) => openCodeEnvRuntime.applyOpencodeBinaryFromSettings(...args);
const resolveOpencodeCliPath: typeof openCodeEnvRuntime.resolveOpencodeCliPath = (...args) => openCodeEnvRuntime.resolveOpencodeCliPath(...args);
const isBundledOpenCodePath: typeof openCodeEnvRuntime.isBundledOpenCodePath = (...args) => openCodeEnvRuntime.isBundledOpenCodePath(...args);
const isExecutable: typeof openCodeEnvRuntime.isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor: typeof openCodeEnvRuntime.searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn: typeof openCodeEnvRuntime.resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const resolveManagedOpenCodeLaunchSpec: typeof openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec = (...args) => openCodeEnvRuntime.resolveManagedOpenCodeLaunchSpec(...args);
const clearResolvedOpenCodeBinary: typeof openCodeEnvRuntime.clearResolvedOpenCodeBinary = (...args) => openCodeEnvRuntime.clearResolvedOpenCodeBinary(...args);
const openCodeResolutionRuntime = createOpenCodeResolutionRuntime({
  path,
  resolveOpencodeCliPath,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  resolveManagedOpenCodeLaunchSpec,
  getResolvedState: () => ({
    resolvedOpencodeBinary,
    resolvedOpencodeBinarySource,
    useWslForOpencode,
    resolvedWslBinary,
    resolvedWslOpencodePath,
    resolvedWslDistro,
    resolvedNodeBinary,
    resolvedBunBinary,
  }),
  setResolvedOpencodeBinarySource: (value) => {
    resolvedOpencodeBinarySource = value;
  },
});
const getOpenCodeResolutionSnapshot: typeof openCodeResolutionRuntime.getOpenCodeResolutionSnapshot = (...args) =>
  openCodeResolutionRuntime.getOpenCodeResolutionSnapshot(...args);

if (!FRONT_DOOR) applyLoginShellEnvSnapshot();

const notificationTemplateRuntime = createNotificationTemplateRuntime({
  fetchImpl: agentUpstream?.fetch ?? fetch,
  readDisplayMetadata: agentUpstream ? (directory) => readAgentDisplayMetadata(agentUpstream, directory) : null,
  readSettingsFromDisk,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
  resolvePrimaryWorktreeRoot,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
});

const notificationChannelHandles = createOutboundHandles();
setHostCallbackRoute(NOTIFICATIONS_OUTBOUND_PATH, {
  refusal: notificationChannelHandles.refusal,
  serve: notificationChannelHandles.serve,
});
const notificationCenter = createNotificationCenterRuntime({
  persistence: createNotificationCenterPersistence({ dataDir: OPENCHAMBER_DATA_DIR }),
  broadcast: broadcastOpenChamberUiEvent,
});
const recordCenterNotification = (entry: Parameters<typeof notificationCenter.record>[0]) => {
  void notificationCenter.record(entry).catch((error) => {
    console.warn('[notification-center] could not record a notification:', error?.message ?? error);
  });
};
{
  const currentVersion = getInstalledOpenChamberVersion();
  if (isString(currentVersion) && currentVersion !== 'unknown') {
    void createAppVersionMarker({ dataDir: OPENCHAMBER_DATA_DIR }).noteVersion(currentVersion).then((previous) => {
      if (!previous) return;
      recordCenterNotification({
        kind: 'update', priority: 'low', delivery: 'delivered',
        title: `OpenChamber updated to ${currentVersion}`,
        body: `Previous version: ${previous}`,
        action: { type: 'openchamber-update', version: currentVersion },
      });
    });
  }
}

const extensionNotificationChannels = FRONT_DOOR ? null : createExtensionNotificationChannels({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  accounts: createNotificationChannelAccounts({ persistPath: notificationChannelsPersistPath(OPENCHAMBER_DATA_DIR) }),
  handles: notificationChannelHandles,
  isAnyUiVisible,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  fetchImpl: agentUpstream?.fetch ?? fetch,
  readSettingsFromDisk,
  prepareNotificationLastMessage,
  buildTemplateVariables,
  extractLastMessageText,
  fetchLastAssistantMessageText,
  resolveNotificationTemplate,
  shouldApplyResolvedTemplateMessage,
  emitDesktopNotification,
  broadcastUiNotification,
  sendPushToAllUiSessions,
  sendApnsToAllUiSessions,
  clearApnsNotifications,
  openPushTagsStore: {
    read: async () => {
      try {
        const saved: JsonValue = JSON.parse(await fsPromises.readFile(PUSH_OPEN_TAGS_FILE_PATH, 'utf8'));
        return saved;
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async (state) => {
      await fsPromises.mkdir(path.dirname(PUSH_OPEN_TAGS_FILE_PATH), { recursive: true });
      await fsPromises.writeFile(PUSH_OPEN_TAGS_FILE_PATH, JSON.stringify({ version: 1, ...state }), { encoding: 'utf8', mode: 0o600 });
    },
  },
  isAnyInteractiveClientVisible,
  isAnyUiVisible,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  recordNotification: recordCenterNotification,
  awaitTurnVerdict: async (sessionId) => sessionWorkRuntime?.awaitTurnVerdict(sessionId) ?? null,
  getSpacesHost: () => spacesHost,
  isInAutoReview: (sessionId, turnEndedAt) => autoReviewRuntime?.speaksFor(sessionId, turnEndedAt) ?? false,
  deliverToExtensionChannels: (delivery) => extensionNotificationChannels?.deliver(delivery),
});

const maybeSendPushForTrigger: typeof notificationTriggerRuntime.maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);
const setAutoAcceptSession = (sessionId: string, enabled: boolean) => requireLocalRuntime(permissionAutoAcceptRuntime, 'Permission auto-accept').setSessionPolicy(sessionId, enabled);
clearPendingPushBadge = () => notificationTriggerRuntime.clearPendingPushBadge();

const sessionLineage = createSessionLineage();
const isLocalSessionArchived = (sessionId: string) => requireLocalRuntime(openChamberSessionService, 'Session archive').sessionArchive.isArchived(sessionId);

const unreadBaseline = createUnreadBaseline({ dataDir: OPENCHAMBER_DATA_DIR });
void unreadBaseline.get();

const turnDurationRecorder = FRONT_DOOR ? null : createTurnDurationRecorder({
  persistSessionMetadataPatch: (...args) => persistSessionMetadataPatch(...args),
  isChildSession: (sessionID) => sessionLineage.isChild(sessionID),
});

const sessionAssistRuntime = FRONT_DOOR ? null : createSessionAssistRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  persistSessionAssist: (sessionID, directory, assist) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { assist } }, { directory }),
  isSessionArchived: isLocalSessionArchived,
  evaluateTurn: (input) => requireLocalRuntime(sessionWorkRuntime, 'Session work').evaluateTurnEnd(input),
  lineage: sessionLineage,
  onPendingChange: ({ sessionId, directory, pending }) => broadcastOpenChamberUiEvent({
    type: 'openchamber:session-assist',
    properties: { sessionID: sessionId, directory: directory || null, pending },
  }),
});

const jevClient = createJevClient();
const sessionGoalRuntime = FRONT_DOOR ? null : createSessionGoalRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService: async () => import('./lib/small-model/index.js'),
  classifierEndpoint: () => requireLocalRuntime(routingRuntime, 'Model routing').classifierEndpoint(),
  jev: createJevClient({ timeoutMs: JEV_BACKGROUND_TIMEOUT_MS }),
  readSessionMetadata: readStoredSessionMetadata,
  isGoalDriverActive: async (driver) => {
    const guests = await listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) });
    return guests.some((guest) => guest.enabled && guest.goal?.driver === driver);
  },
  persistSessionGoal: createGoalPersistence(persistSessionMetadataPatch, updateSessionMetadataWith),
  emitGoalNotification: async ({ sessionId, directory, status, goal }) => {
    const title = status === 'complete'
      ? 'Goal complete'
      : (status === 'budgetLimited' ? 'Goal reached its token budget' : 'Goal blocked');
    const detail = goal?.statusReason && goal.statusReason !== 'verified by audit' && goal.statusReason !== 'reported by agent'
      ? goal.statusReason
      : '';
    const objective = isString(goal?.objective) ? goal.objective.slice(0, 140) : '';
    await notificationTriggerRuntime.notifyGoalSettle({
      sessionId,
      directory,
      status,
      title,
      body: [objective, detail].filter(Boolean).join(' · ').slice(0, 240),
    }).catch((error) => {
      console.warn('[session-goal] notification delivery failed:', error?.message || error);
    });
  },
});

const openCodeSessionClient = (directory?: string) => createOpenCodeClient({
  baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
  headers: getOpenCodeAuthHeaders(),
  directory,
});

const mcpToolsRuntime = createMcpToolsRuntime({
  resolveProjectDirectory: async (projectId) => {
    const project = (await listConfiguredProjects()).find((entry) => entry.id === projectId);
    if (!project) return null;
    const validated = await validateDirectoryPath(project.path);
    if (!validated.ok) throw Object.assign(new Error(validated.error), { statusCode: 400 });
    return validated.directory;
  },
  createClient: openCodeSessionClient,
  isExternalOpenCode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START,
});

const guestInstructions = createGuestInstructions({ dataDir: OPENCHAMBER_DATA_DIR });
const guestAgentContext = createGuestAgentContext({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  instructions: guestInstructions,
});

const sessionLead: ReturnType<typeof createSessionLeadServer> | null = FRONT_DOOR ? null : createSessionLeadServer({
  dataDir: OPENCHAMBER_DATA_DIR,
  readSessionMetadata: (sessionID, options) => readStoredSessionMetadata(sessionID, options),
  updateMetadata: (sessionID, decide, directory) => updateSessionMetadataWith(sessionID, decide, { directory }),
  resolveSessionDirectory: (sessionID): Promise<string | null> => openChamberControlService?.resolveSessionDirectory(sessionID) ?? Promise.resolve(null),
  syncBriefEntry: (sessionID, directory, brief): Promise<boolean> => sessionKnowledgeRuntime?.syncLeadBrief(sessionID, directory, brief) ?? Promise.resolve(false),
  executeControl: (...args) => {
    if (!openChamberControlService) throw new OpenChamberControlError('Lead control is unavailable', 503);
    return openChamberControlService.execute(...args);
  },
  readWorkflowSettings: () => readWorkflowSettings(),
  createError: (message, status) => new OpenChamberControlError(message, status),
  buildOpenCodeUrl: (route, directory) => buildOpenCodeUrl(route, directory), getOpenCodeAuthHeaders: () => getOpenCodeAuthHeaders(),
  isSessionWarm: (sessionID, cacheLifetimeMs) => sessionWarmingRuntime?.isSessionWarm(sessionID, cacheLifetimeMs) ?? false,
  registerResult: (entry) => {
    if (!dispatchResultsRuntime) throw new OpenChamberControlError('Lead handover is unavailable', 503);
    return dispatchResultsRuntime.register(entry);
  },
});

const sessionKnowledgeRuntime: ReturnType<typeof createManagedSessionKnowledgeRuntime> | null = projectContextRuntime && agentMemoryRuntime ? createManagedSessionKnowledgeRuntime({
  isToolHost: () => !isExternalOpenCode && !ENV_SKIP_OPENCODE_START,
  readSettings: () => readSettingsFromDiskMigrated(),
  readExtensionInstructions: guestAgentContext.instructionText,
  readLeadBrief: sessionLead?.readBriefForEntry ?? null,
  projectContextRuntime,
  agentMemoryRuntime,
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  isAgentMemoryEnabled,
  isWorkflowToolEnabled: () => isWorkflowToolEnabled(),
  readCheckoutBranch: getCheckedOutBranch,
  listWorktrees: getWorktrees,
  readPlaceholderBranch: readRenameableGeneratedBranch,
  isReadAloudEnabled: async () => (await readSettingsFromDiskMigrated().catch(() => null))?.showMessageTTSButtons === true,
  readSessionMetadata: readStoredSessionMetadata,
  persistSessionMetadata: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
  collectFollowedPullStacks: (directory, session) => featureRoutesRuntime.collectFollowedPullStacks(directory, session),
  openCodeSessionClient,
}) : null;

const contextObligatoryRuntime = FRONT_DOOR ? null : createContextObligatoryRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata: readStoredSessionMetadata,
  persistContextCursor: (sessionID, directory, patch) => persistSessionMetadataPatch(sessionID, patch, { directory }),
});

const sessionWarmingRuntime = FRONT_DOOR ? null : createSessionWarmingRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcast: broadcastOpenChamberUiEvent,
});
sessionWarmingRuntime?.start();

const trackerRegistry = createTrackerRegistry(undefined, {
  foreignIds: sourceControlProviderDescriptors.list().map((descriptor) => descriptor.id),
});
const trackerSessionStatus = FRONT_DOOR ? null : createTrackerSessionStatus({ registry: trackerRegistry });
const extensionSessionEvents = FRONT_DOOR ? null : createExtensionSessionEvents({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchLastAssistantMessageText,
  readSessionMetadata: readStoredSessionMetadata,
  isSessionAutoAccepting: (sessionId, directory, requestId) => requireLocalRuntime(permissionAutoAcceptRuntime, 'Permission auto-accept').isPermissionAutoAnswered(sessionId, directory, requestId),
  isInAutoReview: (sessionId, turnEndedAt) => requireLocalRuntime(autoReviewRuntime, 'Auto review').speaksFor(sessionId, turnEndedAt),
});

const extensionServiceLifetime = FRONT_DOOR ? null : createServiceLifetime({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  holdService: holdGuestService,
  serviceStatus: getServiceStatus,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
});

const hiddenSessions = createHiddenSessionRegistry();

const globalMessageStreamHub = createGlobalMessageStreamHub({
  isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
  fetchImpl: agentUpstream?.fetch ?? fetch,
  upstreamOrigin: FRONT_DOOR ? 'agent' : null,
  upstreamPath: FRONT_DOOR ? '/api/global/event' : '/api/event',
  isHiddenPayload: hiddenSessions.isHiddenPayload,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
  deltaCoalesceWindowMs: resolveDeltaCoalesceWindowMs(),
});

const routingRuntime = FRONT_DOOR ? null : createRoutingRuntime({
  jev: jevClient,
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  isSessionWarm: (sessionId, cacheLifetimeMs) => requireLocalRuntime(sessionWarmingRuntime, 'Session warming').isSessionWarm(sessionId, cacheLifetimeMs),
});

const sessionWorkRuntime = FRONT_DOOR ? null : createSessionWorkRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  classifierEndpoint: () => requireLocalRuntime(routingRuntime, 'Model routing').classifierEndpoint(),
  jev: createJevClient({ timeoutMs: JEV_BACKGROUND_TIMEOUT_MS }),
  readMetadata: (sessionID, directory) => sessionMetadataStore.get(sessionID, { directory }),
  updateMetadata: updateSessionMetadataWith,
  isSessionArchived: isLocalSessionArchived,
  isWorktreePinned: isWorktreeDirectoryPinned,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  lineage: sessionLineage,
  activityProbe: createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: 2_000 }),
});

const spacePermissionDefaultFile = process.env.OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE;
const sessionInterruptionRuntime = FRONT_DOOR ? null : createSessionInterruptionRuntime({
  persistMetadata: persistSessionMetadataPatch,
  updateMetadata: updateSessionMetadataWith,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  onPendingQuestion: ({ sessionId, directory, sessionTitle, title }) => recordCenterNotification({
    kind: 'question', priority: 'high', delivery: 'delivered',
    title: 'Interrupted question waiting for you', body: title,
    sessionId, directory, sessionName: sessionTitle,
  }),
});
const automationAdmission: ReturnType<typeof createAutomationAdmission> | null = FRONT_DOOR ? null : createAutomationAdmission({
  restore: async (): Promise<readonly AutomationClaim[]> => {
    if (!autoReviewRuntime) throw new Error('Session automation cannot restore review ownership');
    await Promise.all([autoReviewRuntime.load(), prFixLoopRuntime.load()]);
    return [...autoReviewRuntime.ownershipClaims(), ...prFixLoopRuntime.ownershipClaims()];
  },
  onRelease: (keys) => {
    for (const key of keys) if (key.startsWith('session:')) messageQueueRuntime?.release(key.slice('session:'.length));
    prWatchRuntime?.release(keys);
  },
});
const autoResumeRuntime = FRONT_DOOR ? null : createAutoResumeRuntime({
  updateMetadata: updateSessionMetadataWith,
  readMemory: () => readCgroupMemory(),
  sendPrompt: async ({ sessionId, directory, text, description, metadata }) => {
    if (!automationAdmission) throw new Error('Session automation admission is unavailable');
    await automationAdmission.ready();
    const release = automationAdmission.trySend(null, [sessionKey(sessionId)]);
    if (!release) throw new Error('The session is owned by an automation. Its restart notice remains available.');
    try {
      const headers = { ...getOpenCodeAuthHeaders() };
      if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
      return await OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers })
        .session.synthetic(
          { sessionID: sessionId, text, description, metadata, delivery: 'steer', resume: true },
          { signal: AbortSignal.timeout(15_000) },
        );
    } finally { release(); }
  },
});
const permissionAutoAcceptRuntime = FRONT_DOOR ? null : createPermissionAutoAcceptRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent: broadcastPermissionUiEvent,
  evaluatePermission: (permission, directory) => requireLocalRuntime(routingRuntime, 'Model routing').evaluatePermission(permission, directory),
  onPermissionReplied: (permissionId) => requireLocalRuntime(routingRuntime, 'Model routing').forgetPermission(permissionId),
  resolveLegacyEnabledMode: async () => ((await requireLocalRuntime(routingRuntime, 'Model routing').legacySafetyNetEnabled()) ? 'safety' : 'auto'),
  readDefaultMode: spacePermissionDefaultFile
    ? () => readSpacePermissionDefault(spacePermissionDefaultFile)
    : undefined,
});
permissionAutoAcceptRuntime?.start();
notificationTriggerRuntime.setGetIsSessionAutoAccepting(
  (sessionId, directory, permissionId) => permissionAutoAcceptRuntime?.isPermissionAutoAnswered(sessionId, directory, permissionId) ?? false,
);

const autoReviewRuntime = FRONT_DOOR ? null : createAutoReviewRuntime({
  automation: automationAdmission,
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  onRunSettled: (sessionId) => requireLocalRuntime(messageQueueRuntime, 'Message queue').release(sessionId),
  onRunEnded: (ended) => notificationTriggerRuntime.notifyAutoReviewEnded(ended),
  routeSend: ({ sessionId, directory, text }) => {
    const routing = requireLocalRuntime(routingRuntime, 'Model routing');
    return routing.isAutoSession(sessionId) ? routing.routeSend({ sessionId, directory, body: { text } }) : null;
  },
  dataDir: OPENCHAMBER_DATA_DIR,
});
autoReviewRuntime?.start();

const messageQueueRuntime = FRONT_DOOR ? createBotConversationQueue({
  dataDir: OPENCHAMBER_DATA_DIR, globalEventHub: globalMessageStreamHub, buildOpenCodeUrl, getOpenCodeAuthHeaders,
  fetchImpl: requireLocalRuntime(agentUpstream, 'Agent upstream').fetch, broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  assertDispatchAdmission: (input) => requireLocalRuntime(botsHost, 'Bot conversation admission').admitConversationMessage(input),
}) : createMessageQueueRuntime({
  automation: automationAdmission,
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (send) => requireLocalRuntime(routingRuntime, 'Model routing').resolveAutoSelection(send),
  persistSessionGoal: (sessionID, directory, goal) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory }),
  isDeliveryHeld: (sessionId) => requireLocalRuntime(autoReviewRuntime, 'Auto review').holdsDelivery(sessionId),
  deliveryHoldReady: requireLocalRuntime(autoReviewRuntime, 'Auto review').startupLoad,
  beforeScheduledTaskSend: (...args) => requireLocalRuntime(scheduledTasksRuntime, 'Scheduled tasks').beforeScheduledTaskSend(...args),
  validateScheduledTaskTarget: (...args) => requireLocalRuntime(scheduledTasksRuntime, 'Scheduled tasks').validateTarget(...args),
  assertFixLoopHostDispatch: (...args) => prFixLoopRuntime.assertHostDispatch(...args),
  assertBotDispatch: (input) => {
    if (!botsHost) throw Object.assign(new Error('Bot dispatch is unavailable'), { code: 'BOT_HOST_REQUIRED' });
    return botsHost.assertDispatch(input);
  },
  onScheduledTaskResult: (...args) => requireLocalRuntime(scheduledTasksRuntime, 'Scheduled tasks').onScheduledTaskResult(...args),
  dataDir: OPENCHAMBER_DATA_DIR,
});
messageQueueRuntime?.start();

const announcedRestackConflicts = new Set<string>();
const recordRestackConflict = (run: RestackRun) => {
  if (run.status !== 'paused' || run.conflictMode !== 'pause') return;
  const step = run.steps.find((candidate) => candidate.status === 'conflict');
  const key = `${run.id}\0${step?.branch ?? ''}`;
  if (announcedRestackConflicts.has(key)) return;
  announcedRestackConflicts.add(key);
  recordCenterNotification({
    kind: 'restack', priority: 'high', delivery: 'delivered',
    title: 'Restack stopped on a conflict',
    body: step?.branch ? `${step.branch} onto ${step.onto ?? ''}`.trim() : '',
    sessionId: run.sessionId, directory: run.directory, requestId: run.id,
  });
};
const prStackRestackRuntime = !FRONT_DOOR ? createRestackRuntime({
  runGit: runGitCommandNoEditor,
  dataDir: OPENCHAMBER_DATA_DIR,
  readConflictMode: async () => ((await readSettingsFromDisk().catch(() => null))?.prStackConflictMode === 'agent' ? 'agent' : 'pause'),
  sendToSession: async ({ sessionId, directory, text }) => {
    await messageQueueRuntime.enqueue(sessionId, directory, {
      content: 'Stacked PRs: resolve the restack conflict', text, origin: { kind: 'pr-stack', id: sessionId },
    });
  },
  broadcast: (event) => {
    broadcastOpenChamberUiEvent(event);
    recordRestackConflict(event.properties.run);
  },
}) : null;
const prFixLoopActivity = FRONT_DOOR ? null : createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
const approvalGit = FRONT_DOOR ? null : createHostGit({ runCommand: (_binary, args, options) => runSpaceCommand(resolveGitBinaryForSpawn(), args, options) });
const agentFixLoopServices = agentUpstream ? createAgentFixLoopServices(agentUpstream) : null;
const agentBotServices = agentUpstream ? createAgentBotServices(agentUpstream) : null;
const frontDoorFixLoopAdmission = FRONT_DOOR ? createFrontDoorFixLoopAdmission() : undefined;
const approvalGitServices = () => FRONT_DOOR
  ? requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services')
  : requireLocalRuntime(featureRoutesRuntime.fixLoopGitServices(), 'Fix-loop Git services');
const exactFixLoopOctokit = async (accountId?: string | null) => {
  const github = await import('./lib/github/octokit.js');
  if (!accountId) return github.getOctokitOrNull('github.com');
  return (await github.getOctokitForAccountId(accountId))?.octokit ?? null;
};
const approvalWorker = createSpaceWorker({
  dataDir: OPENCHAMBER_DATA_DIR, getHost: () => spacesHost, git: approvalGit, gitServices: approvalGitServices,
  upstream: FRONT_DOOR ? agentUpstream : null,
  seedHead: FRONT_DOOR ? createAgentHeadTransfer({ upstream: requireLocalRuntime(agentUpstream, 'Agent upstream'),
    services: requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services'), dataDir: OPENCHAMBER_DATA_DIR, gitPath: resolveGitBinaryForSpawn() }) : null,
  readHostSession: FRONT_DOOR ? requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services').readHostSession : async (sessionId) => {
    const response = await fetch(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
      headers: getOpenCodeAuthHeaders(), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('The original host session is unavailable');
    return unwrapOpenCodeResponse(await response.json());
  },
});
const prFixLoopRuntime: ReturnType<typeof createFixLoopRuntime> = createFixLoopRuntime<FixLoopClient>({
  approvalOnly: FRONT_DOOR,
  excludeBotWatches: AGENT_SERVER,
  assertBotWatchAvailable: FRONT_DOOR ? (input) => assertAgentBotWatchAvailable({ upstream: requireLocalRuntime(agentUpstream, 'Agent upstream'),
    runtime: prFixLoopRuntime, isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)), input }) : null,
  automation: automationAdmission,
  dataDir: OPENCHAMBER_DATA_DIR,
  ...createFixLoopHostAdapters({
    frontDoor: FRONT_DOOR, getBotHost: () => botsHost, localOctokit: exactFixLoopOctokit,
    getAgentFixLoops: () => requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services'),
    getAgentBots: () => requireLocalRuntime(agentBotServices, 'Agent Bot services'),
    getActivity: () => requireLocalRuntime(prFixLoopActivity, 'Fix-loop activity'),
    getQueue: () => messageQueueRuntime,
    readHostTokens: (...args) => createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders })(...args),
  }),
  workerRuntime: approvalWorker,
  publication: createApprovalPublication({ dataDir: OPENCHAMBER_DATA_DIR, git: approvalGit, gitServices: approvalGitServices,
    captureRef: FRONT_DOOR ? requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services').captureRef : null }),
  applyReviewOperation: (input) => approvalGitServices().applyReviewOperation(input),
  notify: async (loop) => {
    if (loop.botAuthority) { requireLocalRuntime(botsHost, 'Bot host').onPullRequestSettled({ ...loop, botAuthority: loop.botAuthority }); return; }
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    const titles = new Map([
      ['ready', 'Pull request is ready'], ['closed', 'Pull request closed'],
      ['limitReached', 'Fix loop reached its iteration limit'], ['budgetReached', 'Fix loop reached its token budget'],
      ['error', 'Fix loop stopped'],
    ]);
    const prReady = loop.status === 'watching' && loop.statusReason === 'pr-ready';
    const title = prReady ? 'Pull request is ready' : titles.get(loop.status) ?? 'Fix loop finished';
    const reason = prReady ? 'still watching for new CI failures and reviews' : loop.statusReason;
    const notificationPayload = {
      title,
      body: [`#${loop.number} ${loop.title}`.trim(), reason].filter(Boolean).join(' · ').slice(0, 240),
      tag: `pr-fix-loop-${loop.id}`, kind: 'goal', sessionId: loop.sessionId, directory: loop.directory,
    };
    const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
    broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
    recordCenterNotification({
      kind: 'fix-loop', priority: prReady || loop.status === 'ready' || loop.status === 'closed' ? 'normal' : 'high',
      delivery: 'delivered', title, body: notificationPayload.body,
      sessionId: loop.sessionId, directory: loop.directory, requestId: loop.id,
    });
    void notificationTriggerRuntime.sendGoalSettlePush({
      sessionId: loop.sessionId, directory: loop.directory, status: prReady || loop.status === 'ready' ? 'complete' : 'blocked',
      title, body: notificationPayload.body,
    }).catch((error) => console.warn('[pr-fix-loop] push fanout failed:', error?.message || error));
  },
  notifyAwaitingApproval: async (loop) => {
    recordCenterNotification({
      kind: 'fix-loop', priority: 'high', delivery: 'delivered',
      title: 'Fix loop is waiting for your approval', body: `#${loop.number} ${loop.title}`.trim().slice(0, 240),
      sessionId: loop.sessionId, directory: loop.directory, requestId: loop.id,
    });
  },
  resolveNotifications: (loop) => notificationCenter.resolve({ sessionId: loop.sessionId, kinds: ['fix-loop'], requestId: loop.id }),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  readDefaults: async () => (await readSettingsFromDisk().catch(() => null))?.prFixLoopDefaults ?? {},
});

const dispatchResultsRuntime = FRONT_DOOR ? null : createDispatchResultsRuntime({
  globalEventHub: globalMessageStreamHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir: OPENCHAMBER_DATA_DIR,
  isSessionArchived: isLocalSessionArchived,
});
dispatchResultsRuntime?.start();

const prWatchRuntime = FRONT_DOOR ? null : createPrWatchRuntime({
  automation: automationAdmission,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  dataDir: OPENCHAMBER_DATA_DIR,
  readCleanupOnMerge: async () => (await readSettingsFromDiskMigrated())?.mergedWorktreeCleanupEnabled === true,
  isSessionArchived: isLocalSessionArchived,
  insideSpace: Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE),
});
prWatchRuntime?.start(globalMessageStreamHub);
const extensionWaitsRuntime = FRONT_DOOR ? null : createExtensionWaitsRuntime({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  proxyServiceRequest: proxyGuestServiceRequest,
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  dataDir: OPENCHAMBER_DATA_DIR,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  isSessionArchived: isLocalSessionArchived,
  insideSpace: Boolean(process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE),
});
extensionWaitsRuntime?.start(globalMessageStreamHub);
const renderDeliveryFetch = botConversationDeliveryFetch(() =>
  botChildServer?.artifacts.delivery ?? botExecutionServices?.artifacts.delivery ?? botsHost?.artifacts.local?.delivery ?? null);
const laterPagesRuntime = FRONT_DOOR ? null : createLaterPages({
  fetchImpl: renderDeliveryFetch,
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastUiEvent: broadcastOpenChamberUiEvent,
  readArchiveState: (sessionID, options) => requireLocalRuntime(openChamberSessionService, 'Session archive').sessionArchive.archiveState(sessionID, options),
});
laterPagesRuntime?.start(globalMessageStreamHub);
const mergeFollowRuntime = FRONT_DOOR ? null : createMergeFollowRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  notify: (notification) => notificationTriggerRuntime.notifyPullRequest(notification),
});

const readWorkflowSettings = () => readSettingsFromDiskMigrated().catch(() => null);
const isWorkflowToolEnabled = async () => (await readWorkflowSettings())?.agentWorkflowToolEnabled === true;
const workflowAgentSessions = FRONT_DOOR ? null : createWorkflowAgentSessions({
  fetchImpl: renderDeliveryFetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady: (...args) => waitForOpenCodeReady(...args),
  globalEventHub: globalMessageStreamHub,
});
const workflowRuntime = FRONT_DOOR ? null : createWorkflowRuntime({
  store: createWorkflowRunStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR, lighten: lightenWorkflowRun }),
  agentSessions: requireLocalRuntime(workflowAgentSessions, 'Workflow sessions'),
  postSynthetic: requireLocalRuntime(workflowAgentSessions, 'Workflow sessions').postSynthetic,
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  isEnabled: isWorkflowToolEnabled,
  startsWithoutApproval: (sessionID) => sessionLead?.startsWorkflowWithoutApproval(sessionID) ?? Promise.resolve(false),
  fsPromises,
  path,
});
void workflowRuntime?.start().catch((error) => {
  console.warn('[workflows] failed to restore runs:', error?.message ?? error);
});
const sharePagesRuntime = FRONT_DOOR ? null : createSharePagesRuntime({
  crypto,
  store: createSharePageStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR }),
  relay: createShareRelayClient({ getSigner: createRelayShareSigner({ crypto, relayKeyStore }) }),
  postSynthetic: requireLocalRuntime(workflowAgentSessions, 'Workflow sessions').postSynthetic,
  onAnswerDelivered: (answer) => notificationTriggerRuntime.notifyShareAnswer(answer),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
  isAvailable: isSharingAvailable,
  isRelayBaseAllowed,
  resolveRelayBase: async () => resolveShareRelayBase(await readSettingsFromDiskMigrated().catch(() => null)),
});
void sharePagesRuntime?.start().catch((error) => {
  console.warn('[share-pages] failed to start:', error?.message ?? error);
});
const receivedPagesRuntime = FRONT_DOOR ? null : createReceivedPagesRuntime({
  crypto,
  store: createReceivedPageStore({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR }),
  relay: createShareViewerClient(),
  isAvailable: isSharingAvailable,
  isEnterpriseMode: () => isEnterpriseMode(),
  allowedBases: async () => allowedReceiveBases(await readSettingsFromDiskMigrated().catch(() => null)),
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
});
if (!FRONT_DOOR) globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type !== 'connect') return;
  void requireLocalRuntime(workflowRuntime, 'Workflows').deliverPending();
  void requireLocalRuntime(sharePagesRuntime, 'Shared pages').poll();
});

const messageSearchRuntime = FRONT_DOOR ? null : createMessageSearchRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  getArchivedSessions: () => requireLocalRuntime(openChamberSessionService, 'Session archive').archiveStore.getAll(),
  applyOwnedArchiveState,
  readSettings: async () => {
    const settings = await readSettingsFromDisk();
    return { enabled: isMessageSearchEnabled(settings), reasoning: settings.messageSearchReasoningEnabled === true };
  },
});

const sessionTodosRuntime = FRONT_DOOR ? null : createSessionTodosRuntime({
  dataDir: OPENCHAMBER_DATA_DIR,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  getFlagOverrides: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv()?.OPENCODE_FLAGS,
  isSpaceDirectory,
  broadcast: (event) => broadcastOpenChamberUiEvent(event),
});
void sessionTodosRuntime?.start().catch((error) => {
  console.warn('[session-todos] failed to start:', error?.message ?? error);
});

const chatDirectoryCleanupRuntime = createChatDirectoryCleanupRuntime({
  roots: [OPENCHAMBER_CHATS_DIR, path.join(OPENCHAMBER_DEFAULT_CONFIG_ROOT, 'chats')],
  createClient: () => openCodeSessionClient(''),
  getOwner: () => FRONT_DOOR || ENV_SKIP_OPENCODE_START || isExternalOpenCode || isShuttingDown ? null : openCodeProcess,
});

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort: (...args) => waitForOpenCodePort(...args),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub: globalMessageStreamHub,
  onWirePayload: (payload, { spaceId }) => {
    if (!FRONT_DOOR && !spaceId) chatDirectoryCleanupRuntime.observeWirePayload(payload);
    if (spaceId && isRecord(payload) && payload.type === 'openchamber:space-stream'
      && isRecord(payload.properties) && payload.properties.status === 'connected') botsHost?.reconnect(spaceId);
  },
  onDisconnect: () => { if (!FRONT_DOOR) chatDirectoryCleanupRuntime.onDisconnected(); },
  onPayload: (payload, { spaceId }) => {
    if (!FRONT_DOOR && !spaceId) void chatDirectoryCleanupRuntime.processPayload(payload);
    maybeCacheSessionInfoFromEvent(payload, { spaceId });
    void maybeSendPushForTrigger(payload, { spaceId });
    sessionRuntime.processOpenCodeSsePayload(payload, { spaceId });
    resolveCenterEntriesFor(payload);
    void botsHost?.processPayload(payload, { spaceId });
  },
  onConnect: async () => {
    botsHost?.reconnect();
    if (protectedMcpMirror) { void protectedMcpMirror.push(); return; }
    void chatDirectoryCleanupRuntime.onConnected();
    const readAt = Date.now();
    const statuses = await createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders }).fetchActiveSessionStatuses();
    if (statuses) sessionRuntime.adoptRunningSessions(Object.keys(statuses), readAt);
  },
});

if (!FRONT_DOOR) globalMessageStreamHub.subscribeEvent((event) => {
  const payload = event?.payload;
  if (!isRecord(payload) || payload.type !== 'location.shutdown') return;
  const directory = (isRecord(payload.location) ? payload.location.directory : undefined) ?? event.directory;
  if (isString(directory) && directory && directory !== 'global') void openCodeTrust.forget(directory);
});
if (FRONT_DOOR) globalMessageStreamHub.subscribeEvent((event) => {
  for (const payload of event?.translated?.() ?? []) prFixLoopRuntime.processPayload(payload);
});
if (sessionGoalRuntime) globalMessageStreamHub.subscribeStatus((status) => {
  if (status?.type === 'connect') {
    openCodeTrust.followLocations(true);
    void sessionGoalRuntime.recoverActiveGoals();
    void hiddenSessions.seed(async (cursor): Promise<JsonValue> => {
      const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
      const response = await fetch(buildOpenCodeUrl(`/api/session${query}`, ''), { headers: getOpenCodeAuthHeaders() });
      return response.ok ? response.json() : null;
    }).catch(() => {});
  } else if (status?.type === 'disconnect' || status?.type === 'error') openCodeTrust.followLocations(false);
});

const resolveCenterEntries = (target: Parameters<typeof notificationCenter.resolve>[0]) => {
  void notificationCenter.resolve(target).catch((error) => {
    console.warn('[notification-center] could not resolve notifications:', error?.message ?? error);
  });
};
const resolveCenterEntriesFor = (payload: TranslatedEvent) => {
  const sessionId = payload.properties && 'sessionID' in payload.properties ? payload.properties.sessionID : null;
  if (!sessionId) return;
  if (payload.type === 'message.updated' && payload.properties?.info?.role === 'user') {
    resolveCenterEntries({ sessionId, kinds: ['ready', 'error'] });
  } else if (payload.type === 'permission.replied') {
    resolveCenterEntries({ sessionId, kinds: ['permission'], requestId: payload.properties.requestID || null });
  } else if (payload.type === 'form.settled') {
    resolveCenterEntries({ sessionId, kinds: ['question'], requestId: payload.properties.formID || null });
  }
};

if (!FRONT_DOOR) {
  if (!turnDurationRecorder || !sessionAssistRuntime || !sessionWorkRuntime || !sessionGoalRuntime
    || !prStackRestackRuntime || !sessionInterruptionRuntime || !contextObligatoryRuntime || !sessionWarmingRuntime
    || !trackerSessionStatus || !extensionSessionEvents || !sessionLead) throw new Error('Project session event runtimes are unavailable');
  console.log('[session-assist] listening for session events');
  globalMessageStreamHub.subscribeEvent((event) => {
    const directory = isString(event?.directory) && event.directory && event.directory !== 'global'
      ? event.directory
      : '';
    for (const payload of event?.translated?.() ?? []) {
      // external: https://github.com/anomalyco/opencode OpenCode 2 supplies no plugin abort signal; turn cancellation stops pending OpenChamber actions here.
      if (payload.type === 'session.idle' && 'aborted' in payload.properties && payload.properties.aborted === true) {
        agentToolRuntime?.abortSession?.(payload.properties.sessionID);
      }
      if ((payload.type === 'session.idle' || payload.type === 'session.error') && payload.properties.sessionID !== undefined) {
        openChamberControlService?.releaseAnswerWaits(payload.properties.sessionID);
      }
      sessionLineage.observe(payload);
      const eventDirectory = directory || payload.properties?.directory || '';
      turnDurationRecorder.processPayload(payload, eventDirectory);
      sessionAssistRuntime.processPayload(payload, eventDirectory);
      sessionWorkRuntime.processPayload(payload, eventDirectory);
      sessionGoalRuntime.processPayload(payload, eventDirectory);
      prFixLoopRuntime.processPayload(payload);
      if (payload.type === 'session.idle' || (payload.type === 'session.status' && payload.properties?.status?.type === 'idle')) {
        prStackRestackRuntime.noteSessionIdle(payload.properties?.sessionID);
      }
      sessionInterruptionRuntime.processPayload(payload, eventDirectory);
      contextObligatoryRuntime.processPayload(payload, eventDirectory);
      sessionWarmingRuntime.processPayload(payload);
      sessionLead.processPayload(payload, eventDirectory);
      trackerSessionStatus.processPayload(payload, { spaceId: event?.spaceId ?? null });
      extensionSessionEvents.processPayload(payload, eventDirectory);
    }
  });
}

const processForwardedEventPayload: ForwardEventPayload = (payload, emitSyntheticEvent, { spaceId = null } = { spaceId: null }) => {
  if ((!isRecord(payload) && !Array.isArray(payload)) || !isCallback(emitSyntheticEvent)) {
    return;
  }

  for (const translated of translateWireEvent(payload)) {
    processForwardedServerEvent(translated, emitSyntheticEvent, spaceId);
  }
};

const processForwardedServerEvent = (payload: TranslatedEvent, emitSyntheticEvent: Parameters<ForwardEventPayload>[1], spaceId: string | null = null) => {
  maybeCacheSessionInfoFromEvent(payload, { spaceId });

  if (payload.type !== 'session.status') {
    return;
  }

  const { properties } = payload;
  const statusInfo = properties.status ?? {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const status = isString(statusInfo.type) ? statusInfo.type.trim() : '';

  if (!sessionId || !status) {
    return;
  }

  const running = status === 'busy' || status === 'retry';
  emitSyntheticEvent({
    type: 'openchamber:session-status',
    properties: {
      sessionID: sessionId,
      status,
      timestamp: Date.now(),
      turnStartedAt: running ? (properties.turnStartedAt ?? sessionRuntime.getRunningTurnStart(sessionId) ?? undefined) : undefined,
      metadata: {
        attempt: isNumber(statusInfo.attempt) ? statusInfo.attempt : undefined,
        message: isString(statusInfo.message) ? statusInfo.message : undefined,
        next: isNumber(statusInfo.next) ? statusInfo.next : undefined,
      },
    },
  });

  emitSyntheticEvent({
    type: 'openchamber:session-activity',
    properties: {
      sessionId,
      phase: running ? 'busy' : 'idle',
    },
  });
};


const mcpOAuthSignIn = createMcpOAuthSignIn({
  storePath: path.join(OPENCHAMBER_DATA_DIR, 'mcp-oauth-assignments.json'),
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveProjectDirectory,
  getMcpConfig,
  listMcpConfigs,
  updateMcpConfig,
});

const serverUtilsRuntime = createServerUtilsRuntime({
  getArchivedSessions: () => requireLocalRuntime(openChamberSessionService, 'Session archive').archiveStore.getAll(),
  getUnreadBaseline: () => unreadBaseline.get(),
  getStoredSessionMetadata: () => sessionMetadataStore.listUnmigrated(),
  getMergeSpaceSessionList: () => (spacesHost ? (payload) => {
    if (!spacesHost) throw new TypeError("Cannot read properties of null (reading 'mergeSessionList')");
    return spacesHost.mergeSessionList(payload);
  } : null),
  getSpaceEventHub: () => (spacesHost ? globalMessageStreamHub : null),
  hiddenSessions,
  openCodeTrust,
  mcpOAuthSignIn,
  readWorktreeBootstrapStatus: (directory) => getWorktreeBootstrapGateStatus(directory, { bootstrapStore: worktreeBootstrapStore }),
  fs,
  os,
  path,
  process,
  openCodeReadyGraceMs: OPEN_CODE_READY_GRACE_MS,
  longRequestTimeoutMs: LONG_REQUEST_TIMEOUT_MS,
  getRuntime: () => ({
    openCodePort,
    openCodeBaseUrl,
    openCodeNotReadySince,
    isOpenCodeReady,
    isRestartingOpenCode,
  }),
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  ensureOpenCodeApiPrefix,
  getUpstreamStallTimeoutMs,
  getUiNotificationClients: () => uiNotificationClients,
  getOpenCodePort: () => openCodePort,
  setOpenCodePortState: (value) => {
    openCodePort = value;
  },
  syncToHmrState,
  markOpenCodeNotReady: () => {
    isOpenCodeReady = false;
  },
  setOpenCodeNotReadySince: (value) => {
    openCodeNotReadySince = value;
  },
  clearLastOpenCodeError: () => {
    lastOpenCodeError = null;
  },
  getLoginShellPath: () => {
    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot || !isString(snapshot.PATH) || snapshot.PATH.length === 0) {
      return null;
    }
    return snapshot.PATH;
  },
});

const setOpenCodePort: typeof serverUtilsRuntime.setOpenCodePort = (...args) => serverUtilsRuntime.setOpenCodePort(...args);
const waitForOpenCodePort: typeof serverUtilsRuntime.waitForOpenCodePort = (...args) => agentUpstream ? Promise.resolve(Number(new URL(agentUpstream.origin).port || 80)) : serverUtilsRuntime.waitForOpenCodePort(...args);
const buildAugmentedPath: typeof serverUtilsRuntime.buildAugmentedPath = (...args) => serverUtilsRuntime.buildAugmentedPath(...args);
const buildManagedOpenCodePath: typeof serverUtilsRuntime.buildManagedOpenCodePath = (...args) => serverUtilsRuntime.buildManagedOpenCodePath(...args);

const savesSecrets = !process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE;
const environmentStore = createEnvironmentStore({ filePath: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'environment.json'), savesSecrets });
const listConfiguredProjects = async () => {
  const settings = await readSettingsFromDiskMigrated();
  return sanitizeProjects(settings?.projects || []) ?? [];
};
const resolveBotProject = async (projectId: string) => {
  const project = (await listConfiguredProjects()).find((entry) => entry.id === projectId);
  if (!project) throw Object.assign(new Error('Bot project is unavailable'), { code: 'BOT_PROJECT_NOT_FOUND', status: 404 });
  return project;
};
const environmentRuntime = FRONT_DOOR ? null : composeEnvironmentRuntime({
  store: environmentStore,
  listProjects: listConfiguredProjects,
  spawn,
  commandBaseEnv: () => ({ ...process.env, PATH: buildAugmentedPath() }),
  readOpenCodeServiceEnv: () => readOpenCodeServiceEnv(OPENCODE_CONFIG_DIR),
  isEnterpriseMode: () => isEnterpriseMode(),
});
const staticRoutesRuntime = createStaticRoutesRuntime({
  fetchImpl: agentUpstream?.fetch ?? fetch,
  fs,
  path,
  process,
  express,
  resolveProjectDirectory: FRONT_DOOR ? async () => {
    const { lastDirectory } = await readSettingsFromDiskMigrated();
    const directory = isString(lastDirectory) ? lastDirectory : null;
    return { directory, requestedDirectory: null, error: null };
  } : resolveProjectDirectory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  normalizePwaAppName,
  normalizePwaOrientation,
  isRequestAuthorized: (req, res) => isRequestAuthorized(req, res, { tunnelAuthController, uiAuthController }),
});
const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
  fsPromises,
  path,
  crypto,
  storePath: REMOTE_CLIENTS_FILE_PATH,
});
const clientPushAccess = createClientPushAccess({
  listClients: remoteClientAuthRuntime.listClients,
  authenticateBearerClient: async (req) => {
    const token = getBearerTokenFromRequest(req);
    return token ? (await remoteClientAuthRuntime.authenticateBearerToken(token, req))?.client ?? null : null;
  },
  removeDevicesOfSessions: [apnsRuntime.removeApnsDevicesOfSessions, pushRuntime.removePushDevicesOfSessions],
});
const clientPairingRuntime = createClientPairingRuntime({
  fsPromises,
  path,
  crypto,
  storePath: CLIENT_PAIRING_SESSIONS_FILE_PATH,
  remoteClientAuthRuntime,
});
const featureRoutesRuntime = createFeatureRoutesRuntime({
  clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
  trackers: trackerRegistry,
  trackerSessionStatus,
  pluginSwitchStore: createAdaptivePluginSwitchStore({ managedStore: pluginSwitchStore, globalStore: createGlobalConfigPluginSwitchStore(), isGlobalMode: () => isExternalOpenCode || ENV_SKIP_OPENCODE_START }),
  isPluginSwitchAvailable: () => openCodePluginDelivery({ external: isExternalOpenCode || ENV_SKIP_OPENCODE_START, origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null, ownsConfigFile: managedConfigRuntime?.ownsConfigFile() ?? true }) !== 'remote',
  refreshPluginSwitches: async () => ((isExternalOpenCode || ENV_SKIP_OPENCODE_START) ? { updated: true } : (managedConfigRuntime ? managedConfigRuntime.refreshManagedConfigFile() : { updated: false, reason: 'no-managed-opencode' })),
});
const bootstrapRuntime = createBootstrapRuntime({
  createUiAuth,
  registerServerStatusRoutes,
  registerCommonRequestMiddleware,
  registerAuthAndAccessRoutes,
  registerTtsRoutes,
  registerNotificationRoutes,
  registerOpenChamberRoutes,
  registerAgentToolRoutes: (app, options) => {
    options.agentToolRuntime.registerRoutes(app, options.express);
    sessionLead?.registerRoutes(app, options.express, options.agentToolRuntime.authorizeRequest);
  },
  express,
});
const tunnelWiringRuntime = createTunnelWiringRuntime({
  crypto,
  URL,
  tunnelProviderRegistry,
  tunnelAuthController,
  readSettingsFromDiskMigrated,
  readManagedRemoteTunnelConfigFromDisk,
  normalizeTunnelProvider,
  normalizeTunnelMode,
  normalizeOptionalPath,
  normalizeManagedRemoteTunnelHostname,
  normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs,
  isSupportedTunnelMode,
  upsertManagedRemoteTunnelToken,
  resolveManagedRemoteTunnelToken,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
  setRuntimeManagedRemoteTunnelHostname: (value) => {
    runtimeManagedRemoteTunnelHostname = value;
  },
  getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
  setRuntimeManagedRemoteTunnelToken: (value) => {
    runtimeManagedRemoteTunnelToken = value;
  },
});
const startupPipelineRuntime = createStartupPipelineRuntime({
  createTerminalRuntime,
  createDictationRuntime,
  createMessageStreamWsRuntime,
  createServerStartupRuntime,
});

const openCodeLifecycleState = {
  get openCodeProcess() { return openCodeProcess; },
  set openCodeProcess(value: typeof openCodeProcess) { openCodeProcess = value; },
  get openCodePort() { return openCodePort; },
  set openCodePort(value: typeof openCodePort) { openCodePort = value; },
  get openCodeBaseUrl() { return openCodeBaseUrl; },
  set openCodeBaseUrl(value: typeof openCodeBaseUrl) { openCodeBaseUrl = value; },
  get openCodeWorkingDirectory() { return openCodeWorkingDirectory; },
  set openCodeWorkingDirectory(value: typeof openCodeWorkingDirectory) { openCodeWorkingDirectory = value; },
  get currentRestartPromise() { return currentRestartPromise; },
  set currentRestartPromise(value: typeof currentRestartPromise) { currentRestartPromise = value; },
  get isRestartingOpenCode() { return isRestartingOpenCode; },
  set isRestartingOpenCode(value: typeof isRestartingOpenCode) { isRestartingOpenCode = value; },
  get openCodeApiPrefix() { return openCodeApiPrefix; },
  set openCodeApiPrefix(value: typeof openCodeApiPrefix) { openCodeApiPrefix = value; },
  get openCodeApiPrefixDetected() { return openCodeApiPrefixDetected; },
  set openCodeApiPrefixDetected(value: typeof openCodeApiPrefixDetected) { openCodeApiPrefixDetected = value; },
  get openCodeApiDetectionTimer() { return openCodeApiDetectionTimer; },
  set openCodeApiDetectionTimer(value: typeof openCodeApiDetectionTimer) { openCodeApiDetectionTimer = value; },
  get lastOpenCodeError() { return lastOpenCodeError; },
  set lastOpenCodeError(value: typeof lastOpenCodeError) { lastOpenCodeError = value; },
  get lastOpenCodeLaunchDiagnostics() { return lastOpenCodeLaunchDiagnostics; },
  set lastOpenCodeLaunchDiagnostics(value: typeof lastOpenCodeLaunchDiagnostics) { lastOpenCodeLaunchDiagnostics = value; },
  get lastOpenCodeHealthFailure() { return lastOpenCodeHealthFailure; },
  set lastOpenCodeHealthFailure(value: typeof lastOpenCodeHealthFailure) { lastOpenCodeHealthFailure = value; },
  get lastManagedOpenCodeProcess() { return lastManagedOpenCodeProcess; },
  set lastManagedOpenCodeProcess(value: typeof lastManagedOpenCodeProcess) { lastManagedOpenCodeProcess = value; },
  get lastOpenCodeRestartDiagnostics() { return lastOpenCodeRestartDiagnostics; },
  set lastOpenCodeRestartDiagnostics(value: typeof lastOpenCodeRestartDiagnostics) { lastOpenCodeRestartDiagnostics = value; },
  get isOpenCodeReady() { return isOpenCodeReady; },
  set isOpenCodeReady(value: typeof isOpenCodeReady) { isOpenCodeReady = value; },
  get openCodeNotReadySince() { return openCodeNotReadySince; },
  set openCodeNotReadySince(value: typeof openCodeNotReadySince) { openCodeNotReadySince = value; },
  get isExternalOpenCode() { return isExternalOpenCode; },
  set isExternalOpenCode(value: typeof isExternalOpenCode) { if (isExternalOpenCode !== value) { isExternalOpenCode = value; void managedConfigRuntime?.syncExternalBridge().catch(() => {}); } },
  get isShuttingDown() { return isShuttingDown; },
  set isShuttingDown(value: typeof isShuttingDown) { isShuttingDown = value; },
  get healthCheckInterval() { return healthCheckInterval; },
  set healthCheckInterval(value: typeof healthCheckInterval) { healthCheckInterval = value; },
  get expressApp() { return expressApp; },
  set expressApp(value: typeof expressApp) { expressApp = value; },
  get useWslForOpencode() { return useWslForOpencode; },
  set useWslForOpencode(value: typeof useWslForOpencode) { useWslForOpencode = value; },
  get resolvedWslBinary() { return resolvedWslBinary; },
  set resolvedWslBinary(value: typeof resolvedWslBinary) { resolvedWslBinary = value; },
  get resolvedWslOpencodePath() { return resolvedWslOpencodePath; },
  set resolvedWslOpencodePath(value: typeof resolvedWslOpencodePath) { resolvedWslOpencodePath = value; },
  get resolvedWslDistro() { return resolvedWslDistro; },
  set resolvedWslDistro(value: typeof resolvedWslDistro) { resolvedWslDistro = value; },
};

const openCodeLifecycleRuntime = createOpenCodeLifecycleRuntime({
  state: openCodeLifecycleState,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT,
    ENV_CONFIGURED_OPENCODE_HOST,
    ENV_EFFECTIVE_PORT,
    ENV_CONFIGURED_OPENCODE_HOSTNAME,
    ENV_SKIP_OPENCODE_START,
  },
  syncToHmrState,
  syncFromHmrState,
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  waitForReady,
  normalizeApiPrefix,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  ensureLocalOpenCodeServerPassword,
  resolveManagedOpenCodeLaunchSpec,
  setOpenCodePort,
  setDetectedOpenCodeApiPrefix,
  setupProxy: (...args) => setupProxy(...args),
  ensureOpenCodeApiPrefix,
  clearResolvedOpenCodeBinary,
  buildAugmentedPath,
  buildManagedOpenCodePath,
  getManagedOpenCodeShellEnvSnapshot: getLoginShellEnvSnapshot,
  getActiveSessionCount,
  getWarmupDirectories: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    if (!settings) return [];
    const directories = [];
    if (isString(settings.lastDirectory) && settings.lastDirectory) {
      directories.push(settings.lastDirectory);
    }
    const projects = Array.isArray(settings.projects) ? [...settings.projects] : [];
    projects.sort((a, b) => (b?.lastOpenedAt ?? 0) - (a?.lastOpenedAt ?? 0));
    for (const project of projects) {
      if (isString(project?.path) && project.path) {
        directories.push(project.path);
      }
    }
    const existing = await Promise.all([...new Set(directories)].map(async (directory) => (
      (await fs.promises.stat(directory).catch(() => null))?.isDirectory()
        && await openCodeTrust.isTrusted(directory).catch(() => false)
        ? directory
        : null
    )));
    return existing.filter(Boolean);
  },
  noProjectDirectory: OPENCHAMBER_CHATS_DIR,
  // external: #2638 A managed restart can change the upstream port, so event readers reconnect to the current endpoint.
  onOpenCodeRestarted: ({ cause }) => {
    resetOpenCodeRuntimeProviders();
    if (!isExternalOpenCode && !healthCheckInterval) startHealthMonitoring();
    try {
      messageStreamRuntime?.rebindUpstream();
    } catch (error) {
      console.warn('Failed to rebind message stream after OpenCode restart:', isRecord(error) ? error.message ?? error : error);
    }
    let recovery;
    try {
      recovery = sessionRuntime.interruptBusySessionsAfterRestart();
    } catch (error) {
      console.warn('Failed to reconcile sessions after OpenCode restart:', isRecord(error) ? error.message ?? error : error);
      return;
    }
    if (!sessionInterruptionRuntime || recovery.sessionIds.length === 0) return;
    void sessionInterruptionRuntime.recordRestartInterruptions({ ...recovery, cause })
      .then((recordedSessions) => {
        const details = new Map(recordedSessions.map((session) => [session.sessionId, session]));
        const sessions = recovery.sessionIds.map((sessionId) => details.get(sessionId) ?? { sessionId, directory: null, title: null });
        const notice = { ...restartInterruptedNotification(sessions), ...buildRestartNotification(recovery) };
        broadcastUiNotification(notice);
        const single = sessions.length === 1 ? sessions[0] : null;
        recordCenterNotification({
          kind: 'restart', priority: 'high', delivery: 'delivered', title: notice.title, body: notice.body,
          sessionId: single?.sessionId, directory: single?.directory, sessionName: single?.title,
          action: { type: 'sessions', sessions: sessions.slice(0, 50).map(({ sessionId, directory, title }) => ({
            sessionId, directory: directory || null, title: title || null,
          })) },
        });
      })
      .catch((error) => console.warn('Failed to announce sessions interrupted by the OpenCode restart:', error?.message ?? error));
  },
  getManagedOpenCodeEnv: async () => (retireClaudePlugin({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory: openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(), notify: (payload) => broadcastUiNotification(payload) }), managedConfigRuntime ? managedConfigRuntime.buildManagedChildEnv() : {}),
  getUserEnvironment: () => environmentRuntime?.forOpenCode() ?? {},
  sharedService: FRONT_DOOR || AGENT_SERVER || isInsideBotSpace ? null : createSharedOpenCodeServiceConnector({
    readSettings: () => readSettingsFromDiskMigrated(),
    resolveBinary: () => ensureOpencodeCliEnv(),
    buildEnv: () => stripOpenChamberPrivateEnv({ ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }),
    setAuthPassword: (password, source) => openCodeAuthStateRuntime.setOpenCodeAuthState(password, source),
    resolveLaunch: (binary) => resolveManagedOpenCodeLaunchSpec(binary),
  }),
});

configureOpenCodeCredentials(agentUpstream ? createAgentCredentialSource(agentUpstream) : openCodeCredentialSource({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getLaunchEnvironment: () => openCodeLifecycleRuntime.getManagedOpenCodeProcessEnv(),
  getDefaultDirectory: () => openCodeLifecycleRuntime.getDefaultOpenCodeDirectory(),
}));
if (!FRONT_DOOR) configureProjectStartCommandSource(openCodeProjectStartCommandSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }));

const getOpenCodeCompatibility = async () => {
  if (isExternalOpenCode || ENV_SKIP_OPENCODE_START) {
    const base = ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || `http://127.0.0.1:${openCodePort || ENV_EFFECTIVE_PORT}`;
    const version = await readExternalOpenCodeVersion(base, getOpenCodeAuthHeaders()).catch(() => null);
    return describeOpenCodeCompatibility(version, 'external', false);
  }
  const binary = ensureOpencodeCliEnv();
  const installation = isBundledOpenCodePath(binary) ? 'bundled' : 'managed';
  const version = await readOpenCodeCliVersion(resolveManagedOpenCodeLaunchSpec(binary)).catch(() => null);
  const pinnedByPolicy = Boolean(readEnterprisePolicy().opencodeBinary);
  return describeOpenCodeCompatibility(version, installation, supportsOpenCodeV2Install() && !pinnedByPolicy, binary || null);
};

const getSharedServiceCliBinary = () => (openCodeLifecycleRuntime.isConnectedViaSharedService() && !isEnterpriseMode() ? resolveServiceCliBinary(ensureOpencodeCliEnv(), { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }) : null);
const getOpenCodeUpgradeCapability = () => {
  const activeBinary = lastOpenCodeLaunchDiagnostics?.sourceBinary
    || lastOpenCodeLaunchDiagnostics?.binary
    || resolvedOpencodeBinary;
  return resolveOpenCodeUpgradeCapability({
    isExternal: isExternalOpenCode,
    isSharedService: getSharedServiceCliBinary() !== null,
    hasManagedProcess: Boolean(openCodeProcess),
    activeBinary,
    isBundledBinary: isBundledOpenCodePath,
    pinnedByPolicy: Boolean(readEnterprisePolicy().opencodeBinary),
  });
};

const restartOpenCode: typeof openCodeLifecycleRuntime.restartOpenCode = (...args) => {
  if (FRONT_DOOR) throw Object.assign(new Error('front_door_refused'), { code: 'front_door_refused' });
  return openCodeLifecycleRuntime.restartOpenCode(...args);
};
const waitForOpenCodeReady: typeof openCodeLifecycleRuntime.waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const refreshOpenCodeAfterConfigChange: typeof openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange = (...args) => openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange(...args);
const startHealthMonitoring = () => openCodeLifecycleRuntime.startHealthMonitoring(HEALTH_CHECK_INTERVAL);
const triggerHealthCheck = () => { if (!FRONT_DOOR) return openCodeLifecycleRuntime.triggerHealthCheck(); };
const scheduledChatsScope = createChatsScope(OPENCHAMBER_CHATS_DIR);
const scheduledWorktreeBridge = createUnregisteredScheduledWorktreeBridge();
const scheduledTasksRuntime: ProjectScheduledTasksRuntime | null = projectConfigRuntime ? createScheduledTasksRuntime({
  mode: AGENT_SERVER ? 'exclude-bots' : 'all',
  projectConfigRuntime,
  chatsScope: scheduledChatsScope,
  readSessionMetadata: readStoredSessionMetadata,
  messageQueueRuntime: messageQueueRuntime ?? undefined,
  resolvePrimaryWorktreeRoot,
  isSessionArchived: (sessionID) => {
    if (!openChamberSessionService) throw new Error('The project session archive is unavailable');
    return openChamberSessionService.sessionArchive.isArchived(sessionID);
  },
  createTaskWorktree: (input) => {
    const create = scheduledWorktreeBridge.create;
    if (!create) {
      return Promise.reject(new Error('worktree creation is unavailable'));
    }
    return create(input);
  },
  removeTaskWorktree: (input) => scheduledWorktreeBridge.remove(input),
  isGitRepository: (projectDirectory) => scheduledWorktreeBridge.isGitRepository(projectDirectory),
  readSessionDefaults: createReadSessionDefaults({
    readSettings: readSettingsFromDiskMigrated,
    sanitizeProjects,
    chatsScopeID: scheduledChatsScope.id,
  }),
  resolveAutoSelection: (input) => {
    if (!routingRuntime) throw new Error('Project model routing is unavailable');
    return routingRuntime.resolveAutoSelection(input);
  },
  listProjects: async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []) ?? [];
  },
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  sessionKnowledgeRuntime,
  persistSessionGoal: (sessionID, directory, goal) =>
    persistSessionMetadataPatch(sessionID, { openchamber: { goal } }, { directory }),
  setSessionAutoAccept: permissionAutoAcceptRuntime?.setSessionPolicy ?? null,
  runSuggestedScan: async (projectID, reason): Promise<{ sessionID?: string | null; directory?: string | null; skipped: boolean }> => {
    if (!suggestedTasksRuntime) throw new Error('Suggested tasks are not available on this server');
    const scan = await suggestedTasksRuntime.runScan(projectID, reason);
    if ('sessionID' in scan) return { sessionID: scan.sessionID ?? null, directory: scan.directory ?? null, skipped: Boolean(scan.skipped) };
    return { skipped: Boolean(scan.skipped) };
  },
  runBot: (projectId, botId, occurrence) => {
    if (!botsHost) throw new Error('Bots require the host server');
    return botsHost.runScheduled(projectId, botId, occurrence);
  },
  emitTaskRunEvent: (event) => {
    for (const client of uiOpenChamberEventClients) {
      try {
        const properties: ScheduledTaskRanProperties = {
          projectId: scheduledChatsScope.toPublicID(event.projectID),
          taskId: event.taskID,
          ranAt: event.ranAt,
          status: event.status,
        };
        if (event.sessionID) properties.sessionId = event.sessionID;
        writeSseEvent(client, { type: 'openchamber:scheduled-task-ran', properties });
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    if (event.status === 'error') recordCenterNotification({
      kind: 'scheduled-task', priority: 'high', delivery: 'delivered',
      title: event.taskName?.trim() ? `Scheduled task failed: ${event.taskName.trim()}` : 'Scheduled task failed',
      body: event.error ?? '', sessionId: event.sessionID, directory: event.directory,
      action: { type: 'scheduled-tasks', projectId: scheduledChatsScope.toPublicID(event.projectID) },
    });
  },
  logger: console,
}) : null;
const ownerBotConfig = FRONT_DOOR ? createOwnerBotConfig({ projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR,
  resolveProject: resolveBotProject }) : null;
const ownerBotScheduledTasksRuntime = ownerBotConfig ? createScheduledTasksRuntime({ mode: 'bots-only',
  projectConfigRuntime: ownerBotConfig, listProjects: listConfiguredProjects,
  runBot: (projectId, botId, occurrence) => {
    if (!botsHost) throw new Error('Bots require the host server');
    return botsHost.runScheduled(projectId, botId, occurrence);
  },
  logger: console,
}) : null;
const emitSessionCreatedEvent = (event: SessionCreatedEvent) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      const properties: SessionCreatedProperties = {
        sessionId: event.sessionID,
        directory: event.directory,
        createdAt: event.createdAt,
        promptDispatched: event.promptDispatched === true,
        dispatchedAsCommand: event.dispatchedAsCommand === true,
      };
      if (event.projectID) properties.projectId = event.projectID;
      if (event.title) properties.title = event.title;
      writeSseEvent(client, { type: 'openchamber:session-created', properties });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const resolveMemoryProjectId = createMemoryProjectResolver({
  listProjectPaths: async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
  },
  resolvePrimaryWorktreeRoot,
  managedProjectRoots: [...new Set([path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR])],
});

const emitAgentMemoryChangedEvent = (event: MemoryChangedEvent) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      const properties: MemoryChangedEvent = { scope: event.scope };
      if (event.projectId) properties.projectId = event.projectId;
      writeSseEvent(client, { type: 'openchamber:agent-memory-changed', properties });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};

const memoryDreaming = agentMemoryRuntime ? createMemoryDreaming({
  agentMemoryRuntime,
  readSettings: () => readSettingsFromDiskMigrated(),
  resolveProjectId: (directory) => resolveMemoryProjectId(directory),
  measureIndex: measureMemoryIndex,
  hiddenSessions,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  emitMemoryChanged: emitAgentMemoryChangedEvent,
  isDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory).catch(() => false),
  resolveSessionDefaults,
  isAutoModel,
}) : null;
const readModelCatalog = createModelCatalogReader({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  isOpenCodeDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory),
});
const scheduledTaskService: ReturnType<typeof createScheduledTaskService> | null = projectConfigRuntime && scheduledTasksRuntime ? createScheduledTaskService({
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  projectConfigRuntime,
  scheduledTasksRuntime,
  chatsScope: scheduledChatsScope,
  resolvePrimaryWorktreeRoot,
  readModelCatalog,
}) : null;
const sessionServiceDependencies: Parameters<typeof createOpenChamberSessionService>[0] | null = routingRuntime && projectConfigRuntime ? {
  onSessionArchived: (sessionID, archivedAt) => extensionSessionEvents?.processPayload({
    type: 'openchamber:session-archived',
    properties: { sessionID, archivedAt },
  }),
  chatsScope: scheduledChatsScope,
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  validateDirectoryPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  emitSessionCreatedEvent,
  sessionKnowledgeRuntime,
  worktreeBootstrapStore,
  hydrateWorktreeCheckout: featureRoutesRuntime.hydrateBoundCheckout,
  createChangeRequestWorktree: featureRoutesRuntime.createChangeRequestWorktree,
  dataDir: OPENCHAMBER_DATA_DIR,
  sessionMetadataStore,
  persistSessionMetadata: persistSessionMetadataPatch,
  updateSessionMetadata: updateSessionMetadataWith,
  broadcastGlobalUiEvent: broadcastOpenChamberUiEvent,
  resolveAutoSelection: (input) => routingRuntime.resolveAutoSelection(input),
  isAutoReady: async () => (await routingRuntime.describe()).autoReady,
  readProjectSetup: (projectID) => projectConfigRuntime.readProjectSetup(projectID),
} : null;
const openChamberSessionService: ReturnType<typeof createOpenChamberSessionService> | null = sessionServiceDependencies
  ? createOpenChamberSessionService(sessionServiceDependencies)
  : null;
const readOnlyBotSessionService = sessionServiceDependencies && sessionKnowledgeRuntime ? createOpenChamberSessionService({ ...sessionServiceDependencies,
  sessionKnowledgeRuntime: { sync: (sessionId, directory) => sessionKnowledgeRuntime.sync(sessionId, directory, { includeMemorySaveRule: false }) },
}) : null;
const readBotSessionDefaults = createBotSessionDefaults({ readSettings: readSettingsFromDiskMigrated,
  resolveProject: resolveBotProject, clientFor: openCodeSessionClient });
if (isInsideBotSpace) {
  botChildServer = createBotChildServer({ dataDir: OPENCHAMBER_DATA_DIR, updateMetadata: async (sessionId, patch) => { await persistSessionMetadataPatch(sessionId, patch); },
    readArtifactPage: (origin) => requireLocalRuntime(openChamberControlService, 'Page owner').readPageProjection(origin),
    readSession: (sessionID) => openCodeSessionClient('').session.get({ sessionID }) });
} else if (AGENT_SERVER) {
  botExecutionServices = createBotExecutionServices({ agentServer: true, dataDir: OPENCHAMBER_DATA_DIR,
    readSettings: readSettingsFromDiskMigrated, listProjects: listConfiguredProjects,
    sessionService: requireLocalRuntime(openChamberSessionService, 'Agent session service'), readOnlySessionService: requireLocalRuntime(readOnlyBotSessionService, 'Read-only agent sessions'),
    clientFor: openCodeSessionClient, permissionAutoAcceptRuntime: requireLocalRuntime(permissionAutoAcceptRuntime, 'Agent permission policy'), sessionKnowledgeRuntime: requireLocalRuntime(sessionKnowledgeRuntime, 'Agent knowledge'),
    readSessionDefaults: readBotSessionDefaults, buildOpenCodeUrl, getOpenCodeAuthHeaders,
    updateMetadata: async (sessionId, patch) => { await persistSessionMetadataPatch(sessionId, patch); },
    readArtifactPage: (origin) => requireLocalRuntime(openChamberControlService, 'Page owner').readPageProjection(origin),
    trustMigrationPath: (mapping: NonNullable<MigrationRequest['trustedMigrationPath']>, options: Pick<Parameters<typeof trustMigratedBotCheckout>[0], 'allowMissingCheckout'>) => trustMigratedBotCheckout({ mapping, ...options,
      runGit: (args) => runSpaceCommand(resolveGitBinaryForSpawn(), args, { timeoutMs: 10_000 }) }),
    isSessionArchived: (sessionId: string) => requireLocalRuntime(openChamberSessionService, 'Session archive').sessionArchive.isArchived(sessionId),
    disposeInstance: async (directory: string) => openCodeSessionClient(directory).debug.location.evict({ location: { directory } }),
  });
} else {
  botsHost = createBotsHost({
    dataDir: OPENCHAMBER_DATA_DIR, projectsDir: OPENCHAMBER_PROJECTS_CONFIG_DIR,
    projectConfigRuntime: requireLocalRuntime(ownerBotConfig ?? projectConfigRuntime, 'Bot configuration'),
    scheduledTasksRuntime: requireLocalRuntime(ownerBotScheduledTasksRuntime ?? scheduledTasksRuntime, 'Bot schedules'), listProjects: listConfiguredProjects,
    resolveProject: resolveBotProject, executionServices: agentBotServices, withWatchAdmission: frontDoorFixLoopAdmission,
    sessionService: openChamberSessionService, readOnlySessionService: readOnlyBotSessionService,
    clientFor: openCodeSessionClient, permissionAutoAcceptRuntime, sessionKnowledgeRuntime,
    readSessionDefaults: FRONT_DOOR ? requireLocalRuntime(agentBotServices, 'Agent bot services').readSessionDefaults : readBotSessionDefaults,
    buildOpenCodeUrl, getOpenCodeAuthHeaders, getSpacesHost: () => spacesHost, getSpaceArchive: () => spaceArchive,
    messageQueueRuntime, notificationCenter, notify: notificationTriggerRuntime.notifyBotAttention,
    broadcast: broadcastOpenChamberUiEvent, getFixLoopRuntime: () => prFixLoopRuntime,
    updateMetadata: async (sessionId, patch) => { await persistSessionMetadataPatch(sessionId, patch); },
    readArtifactPage: (origin) => requireLocalRuntime(openChamberControlService, 'Page owner').readPageProjection(origin),
    disposeInstance: async (directory: string) => openCodeSessionClient(directory).debug.location.evict({ location: { directory } }),
  });
}
const browserClientEvents = createBrowserClientEvents({ clients: uiOpenChamberEventClients, writeEvent: writeSseEvent });
const browserControlBroker = FRONT_DOOR ? null : createBrowserControlBroker({
  createId: () => `browser-${crypto.randomUUID()}`,
  emitRequest: browserClientEvents.emitRequest,
});

const emitBrowserProviderResetEvent = ({ guestId, guestName }: BrowserProviderReset) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, {
        type: 'openchamber:browser-provider-reset',
        properties: { guestId, guestName },
      });
    } catch {
      uiOpenChamberEventClients.delete(client);
    }
  }
};
const announceBrowserAgentActivity: NonNullable<Parameters<typeof createBrowserControlRouter>[0]['announceAgentActivity']> = ({ guestId, action, context }) => {
  for (const client of uiOpenChamberEventClients) {
    try {
      writeSseEvent(client, { type: 'openchamber:browser-agent-activity',
        properties: { guestId, action, directory: context?.directory ?? null, sessionId: context?.sessionId ?? null } });
    } catch { uiOpenChamberEventClients.delete(client); }
  }
};
const notifyBrowserHelp: NonNullable<Parameters<typeof createBrowserControlRouter>[0]['notifyBrowserHelp']> = async ({ guestId, reason, kind, context }) => {
  const settings = await readSettingsFromDiskMigrated();
  if (settings.nativeNotificationsEnabled === false) return;
  const sessionId = context?.sessionId || null;
  const directory = context?.directory || null;
  const title = kind === 'login' ? 'The agent needs you to sign in'
    : kind === 'profile' ? 'The agent asks to save its logins in a browser profile' : 'The agent needs your help in the browser';
  if (reason === undefined) throw new TypeError('Browser help notification requires a reason');
  const body = reason.trim().slice(0, 500);
  const notificationPayload = {
    title, body, tag: `browser-help-${sessionId || guestId}`,
    kind: AGENT_SERVER ? 'browser-help' : 'plugin', sessionId, directory, requireHidden: false, guestId,
  };
  const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
  broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
  recordCenterNotification({ kind: 'browser-help', priority: 'high', delivery: 'delivered', title, body, sessionId, directory });
  if (sessionId) await notificationTriggerRuntime.sendBrowserHelpPush({ sessionId, guestId, title, body });
};
const browserControlRouter = FRONT_DOOR ? null : createBrowserControlRouter({
  broker: requireLocalRuntime(browserControlBroker, 'Browser control'),
  readSettings: () => readSettingsFromDiskMigrated(),
  persistSettings: (changes) => persistSettings(changes),
  findGuest: (id) => findInstalledGuest(id, extensionsPersistPath(OPENCHAMBER_DATA_DIR)),
  persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
  emitProviderReset: emitBrowserProviderResetEvent,
  createId: () => `browser-${crypto.randomUUID()}`,
  surfaceControl: {
    userControls: (guestId) => guestSurfaceRuntime?.userControls(guestId) ?? false,
    noteAgentActivity: (guestId) => guestSurfaceRuntime?.noteAgentActivity(guestId),
  },
  notifyBrowserHelp,
  announceAgentActivity: announceBrowserAgentActivity,
});

const fileOpenRequester = createFileOpenRequester({
  emit: (request) => {
    let delivered = 0;
    for (const client of uiOpenChamberEventClients) {
      try {
        writeSseEvent(client, { type: 'openchamber:file-open-request', properties: request });
        delivered += 1;
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    return delivered;
  },
});

const pluginNotificationEmitter = createPluginNotificationEmitter({
  readSettingsFromDiskMigrated,
  emitDesktopNotification,
  broadcastUiNotification,
  recordNotification: recordCenterNotification,
  isSubagentSession: (sessionId, directory) => notificationTriggerRuntime.isSubagentSession(sessionId, directory),
});

const suggestedTasksRuntime = projectConfigRuntime && scheduledTasksRuntime && projectContextRuntime
  && openChamberSessionService && sessionKnowledgeRuntime && permissionAutoAcceptRuntime ? createSuggestedTasksRuntime({
  projectConfigRuntime, scheduledTasksRuntime,
  store: createSuggestionStore({ projectsDirPath: OPENCHAMBER_PROJECTS_CONFIG_DIR }),
  listProjects: listConfiguredProjects,
  projectContextRuntime, sessionService: openChamberSessionService, sessionKnowledgeRuntime, permissionAutoAcceptRuntime,
  readMcpServers: async (directory) => (await openCodeSessionClient(directory).mcp.list({ location: { directory } })).data,
  readSessionDefaults: async (projectID) => {
    const settings = await readSettingsFromDiskMigrated();
    const project = (sanitizeProjects(settings?.projects || []) ?? []).find((entry) => entry.id === projectID) ?? null;
    return resolveSessionDefaults({ settings, project });
  },
  globalEventHub: globalMessageStreamHub,
  git: { readScanCheckout, listChangedPathsSince, addDetachedWorktree, removeDetachedWorktree, getRepositoryRemoteUrls },
  buildOpenCodeUrl, getOpenCodeAuthHeaders,
  notify: (payload) => pluginNotificationEmitter.emit(payload), broadcast: broadcastOpenChamberUiEvent,
  isLinearConnected: () => Boolean(getLinearAuth()),
  readProjectOpenIssues: (directory) => featureRoutesRuntime.readProjectOpenIssues(directory),
  deliverSuggestionToBot: (input) => {
    if (!botsHost) throw new Error('Bots require the host server');
    return botsHost.deliverSuggestion(input);
  },
  scanCheckoutsDir: path.join(OPENCHAMBER_DATA_DIR, 'suggested-tasks', 'checkouts'),
}) : null;
suggestedTasksRuntime?.start();

const secretFiles = createSecretFiles({ directory: path.join(OPENCHAMBER_DATA_DIR, 'secrets') });
void secretFiles.sweep();
setInterval(() => { void secretFiles.sweep(); }, 60 * 60 * 1000).unref();

const insideSpaceTaskNaming = process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE && process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE
  ? createInsideSpaceTaskNaming({
    agentFile: process.env.OPENCHAMBER_SPACE_TASK_TITLE_FILE,
    userFile: process.env.OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE,
    announce: broadcastOpenChamberUiEvent,
  }) : null;

const announceGuestMarksChanged = () => broadcastOpenChamberUiEvent({ type: 'openchamber:guest-marks-changed', properties: {} });
onGuestServiceEnded((guestId) => {
  if (guestMarks.dropEnded(guestId)) announceGuestMarksChanged();
});

const serviceHostApi = FRONT_DOOR ? null : createServiceHostApi({
  listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR) }),
  control: {
    execute: executeServiceControl,
    resolveSessionDirectory: (sessionID) => requireLocalRuntime(openChamberControlService, 'Control service').resolveSessionDirectory(sessionID),
    stopSession: (sessionID) => requireLocalRuntime(openChamberControlService, 'Control service').stopSession(sessionID),
    answerPermission: (input) => requireLocalRuntime(openChamberControlService, 'Control service').answerPermission(input),
    answerForm: (input) => requireLocalRuntime(openChamberControlService, 'Control service').answerForm(input),
    dismissOpenForms: (sessionID) => requireLocalRuntime(openChamberControlService, 'Control service').dismissOpenForms(sessionID),
  },
  instructions: guestInstructions,
  readSettings: async (guest) => (await getGuestAuth(guest.id, guestAuthPersistPath(OPENCHAMBER_DATA_DIR)))?.settings ?? {},
  emitToFrames: (guestId, topic, data) => broadcastOpenChamberUiEvent({
    type: 'openchamber:guest-service-event',
    properties: { guestId, topic, data },
  }),
  setConfigurationNote: (guestId, message) => {
    if (setGuestConfigurationNote(guestId, message)) broadcastOpenChamberUiEvent({ type: 'openchamber:guests-changed', properties: {} });
  },
  marks: {
    set: (...args) => {
      const outcome = guestMarks.set(...args);
      if (outcome === 'changed') announceGuestMarksChanged();
      return outcome;
    },
  },
});
serviceHostApi?.register();

function executeServiceControl(action: 'session.create' | 'session.send', input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionActionResult>;
function executeServiceControl<Action extends SessionReadAction>(action: Action, input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions): Promise<SessionReadResults[Action]>;
function executeServiceControl(action: string, input?: ControlInput, contextDirectory?: ControlInput['directory'], options?: ControlOptions) {
  return requireLocalRuntime(openChamberControlService, 'Control service').execute(action, input, contextDirectory, options);
}

const browserUploadStore = createUploadStore();
const isAgentToolEnabled = async (field: 'agentKnowledgeToolEnabled' | 'agentRenderToolEnabled' | 'agentSecretToolEnabled') =>
  (await readSettingsFromDiskMigrated().catch(() => null))?.[field] !== false;
const openChamberControlService: ReturnType<typeof createOpenChamberControlService> | null = FRONT_DOOR ? null : createOpenChamberControlService({
  artifacts: botChildServer?.artifacts.capture ?? botExecutionServices?.artifacts.capture ?? botsHost?.artifacts.local?.capture,
  assertConversationControlTarget: (action, sessionId) => (botExecutionServices ?? botsHost)?.assertConversationControlTarget(action, sessionId) ?? Promise.resolve(),
  isHiddenSession: (sessionID, record) => hiddenSessions.has(sessionID, record),
  chatsScope: scheduledChatsScope,
  chatRoots: [path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'chats'), OPENCHAMBER_CHATS_DIR],
  updateSessionMetadata: updateSessionMetadataWith,
  isWorktreePinned: isWorktreeDirectoryPinned,
  readPendingRequests: () => sessionRuntime.getPendingBlockingRequestsSnapshot(),
  isPermissionAutoAnswered: (sessionId, directory, permissionId) => requireLocalRuntime(permissionAutoAcceptRuntime, 'Permission auto-accept').isPermissionAutoAnswered(sessionId, directory, permissionId),
  readSettingsFromDiskMigrated,
  sanitizeProjects: sanitizeProjectList,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  isOpenCodeDirectoryTrusted: (directory) => openCodeTrust.isTrusted(directory),
  sessionService: requireLocalRuntime(openChamberSessionService, 'Session service'),
  scheduledTaskService: requireLocalRuntime(scheduledTaskService, 'Scheduled task service'),
  browserControl: browserControlRouter,
  browserUploads: browserUploadStore,
  fileOpen: fileOpenRequester,
  projectContextRuntime,
  resolveProjectContextId: resolveMemoryProjectId,
  showPlan: (request) => {
    let delivered = 0;
    for (const client of uiOpenChamberEventClients) {
      try {
        writeSseEvent(client, { type: 'openchamber:plan-open-request', properties: request });
        delivered += 1;
      } catch {
        uiOpenChamberEventClients.delete(client);
      }
    }
    return delivered;
  },
  isKnowledgeToolEnabled: () => isAgentToolEnabled('agentKnowledgeToolEnabled'),
  isRenderToolEnabled: () => isAgentToolEnabled('agentRenderToolEnabled'),
  isSecretToolEnabled: () => isAgentToolEnabled('agentSecretToolEnabled'),
  secretFiles, savedSecrets: savesSecrets ? createSavedSecrets({ store: environmentStore, projectIdFor: requireLocalRuntime(environmentRuntime, 'Environment').projectIdFor }) : null,
  onPageWaitChange: (change) => {
    sessionRuntime.trackWaitingPage(change);
    if (change.type === 'waiting') {
      const payload = {
        type: 'openchamber:page-waiting',
        properties: { sessionID: change.sessionId, directory: change.directory, page: { id: change.callId, title: change.title } },
      };
      broadcastOpenChamberUiEvent(payload);
      void maybeSendPushForTrigger(payload);
      requireLocalRuntime(extensionSessionEvents, 'Extension events').processPayload(payload, change.directory ?? undefined);
      return;
    }
    const settled = {
      type: 'openchamber:page-settled',
      properties: { sessionID: change.sessionId, pageID: change.callId },
    };
    broadcastOpenChamberUiEvent(settled);
    void maybeSendPushForTrigger(settled);
    requireLocalRuntime(extensionSessionEvents, 'Extension events').processPayload(settled);
    resolveCenterEntries({ sessionId: change.sessionId, kinds: ['question'], requestId: change.callId });
  },
  notifyUser: async (input) => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    if (settings?.agentNotifyToolEnabled !== true) {
      return { status: 403, body: { error: 'The notify tool is turned off in OpenChamber settings' } };
    }
    return pluginNotificationEmitter.emit(input);
  },
  agentMemoryActions: createAgentMemoryActions({
    agentMemoryRuntime: requireLocalRuntime(agentMemoryRuntime, 'Agent memory'),
    createError: (message, status) => new OpenChamberControlError(message, status),
    onMemoryChanged: emitAgentMemoryChangedEvent,
    isAgentMemoryEnabled,
    resolveProjectId: resolveMemoryProjectId,
  }),
  sessionLinks: createSessionLinker({
    trackers: trackerRegistry,
    updateMetadata: updateSessionMetadataWith,
    createError: (message, status) => new OpenChamberControlError(message, status),
  }),
  workNaming: {
    nameSpaceTask: (directory, title) => insideSpaceTaskNaming?.name(directory, title) ?? null,
    listWorktrees: getWorktrees,
    setWorktreeTaskTitle,
    readPlaceholderBranch: (directory) => readRenameableGeneratedBranch(directory),
    renamePlaceholderBranch: renameGeneratedWorktreeBranch,
  },
  dispatchResults: dispatchResultsRuntime,
  prWatch: prWatchRuntime,
  extensionWaits: extensionWaitsRuntime,
  laterPages: process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE ? null : laterPagesRuntime,
  workflowRuntime,
  leadActions: sessionLead?.actions ?? null,
  sharePages: sharePagesRuntime,
  archiveStore: requireLocalRuntime(openChamberSessionService, 'Session archive').archiveStore,
  loadQuota: () => import('./lib/quota/index.js'),
  getTerminalRuntime: () => terminalRuntime,
});

const ensureGlobalWatcherStarted = async () => {
  if (globalWatcherStartPromise) {
    return globalWatcherStartPromise;
  }

  globalWatcherStartPromise = openCodeWatcherRuntime.start().catch((error) => {
    globalWatcherStartPromise = null;
    throw error;
  });

  return globalWatcherStartPromise;
};
const bootstrapOpenCodeAtStartup = async (...args: Parameters<typeof openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup>) => {
  if (FRONT_DOOR) {
    globalMessageStreamHub.subscribeStatus((status) => { isOpenCodeReady = status.type === 'connect'; });
    void ensureGlobalWatcherStarted();
    agentStreams?.start();
    void startOwnerBots();
    return;
  }
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
  if (openCodeLifecycleRuntime.scheduleBootstrapRetry(bootstrapOpenCodeAtStartup, finishOpenCodeBootstrap)) {
    void startFixLoopsAndSchedules();
    return;
  }
  finishOpenCodeBootstrap();
};
let fixLoopsAndSchedulesStart: Promise<void> | null = null;
let ownerBotsStart: Promise<void> | null = null;
const startOwnerBots = () => {
  ownerBotsStart ??= (async () => {
    if (isShuttingDown) return;
    try { await requireLocalRuntime(botsHost, 'Bots coordinator').start(); }
    catch (error) { console.warn('[bots] Owner startup failed:', isRecord(error) ? error.code ?? 'BOT_HOST_START_FAILED' : 'BOT_HOST_START_FAILED'); return; }
    if (!isShuttingDown) await startFixLoopsAndSchedules();
  })();
  return ownerBotsStart;
};
const startFixLoopsAndSchedules = () => {
  fixLoopsAndSchedulesStart ??= (async () => {
    if (isShuttingDown) return;
    try { await prFixLoopRuntime.start(); }
    catch { console.warn('[pr-fix-loop] persisted state could not be loaded; loops remain disabled'); }
    if (isShuttingDown) return;
    try { await requireLocalRuntime(ownerBotScheduledTasksRuntime ?? scheduledTasksRuntime, 'Scheduled tasks').start(); }
    catch (error) { console.warn('[ScheduledTasks] Failed to start runtime:', (isRecord(error) && error.message) || error); }
  })();
  return fixLoopsAndSchedulesStart;
};
const finishOpenCodeBootstrap = () => {
  scheduleOpenCodeApiDetection();
  if (openCodeLifecycleState.openCodeProcess && !openCodeLifecycleState.isExternalOpenCode) {
    startHealthMonitoring();
  }
  void ensureGlobalWatcherStarted().catch((error) => {
    console.warn(`Global event watcher startup failed: ${error?.message || error}`);
  });
  void waitForOpenCodeReady()
    .then(() => sessionMetadataStore.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session metadata migration failed:', error?.message ?? error));
  void (async () => {
    try {
      await waitForOpenCodeReady();
      if (isShuttingDown) return;
      await botsHost?.start();
    } catch (error) {
      console.warn('[bots] Host startup failed:', isRecord(error) ? error.code ?? 'BOT_HOST_START_FAILED' : 'BOT_HOST_START_FAILED');
    }
    await startFixLoopsAndSchedules();
  })();
  void waitForOpenCodeReady()
    .then(() => requireLocalRuntime(openChamberSessionService, 'Session archive').sessionArchive.migrateLegacy())
    .catch((error) => console.warn('[openchamber-sessions] session archive migration failed:', error?.message ?? error));
};
const killProcessOnPort: typeof openCodeLifecycleRuntime.killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);
const waitForPortRelease: typeof openCodeLifecycleRuntime.waitForPortRelease = (...args) => openCodeLifecycleRuntime.waitForPortRelease(...args);

const setupProxy: typeof serverUtilsRuntime.setupProxy = (...args) => { if (!FRONT_DOOR) return serverUtilsRuntime.setupProxy(...args); };
const gracefulShutdownRuntime = createGracefulShutdownRuntime({
  process,
  shutdownTimeoutMs: SHUTDOWN_TIMEOUT,
  getExitOnShutdown: () => exitOnShutdown,
  getIsShuttingDown: () => isShuttingDown,
  setIsShuttingDown: (value) => {
    isShuttingDown = value;
  },
  syncToHmrState,
  openCodeWatcherRuntime,
  chatDirectoryCleanupRuntime,
  sessionAssistRuntime,
  sessionWorkRuntime,
  autoResumeRuntime,
  sessionGoalRuntime,
  contextObligatoryRuntime,
  sessionWarmingRuntime,
  sessionTodosRuntime,
  autoReviewRuntime,
  prWatchRuntime,
  extensionWaitsRuntime,
  messageQueueRuntime,
  prFixLoopRuntime,
  mergeFollowRuntime,
  dispatchResultsRuntime,
  suggestedTasksRuntime,
  workflowRuntime,
  messageSearchRuntime,
  sessionRuntime,
  getHealthCheckInterval: () => healthCheckInterval,
  clearHealthCheckInterval: (value) => clearInterval(value),
  getTerminalRuntime: () => terminalRuntime,
  setTerminalRuntime: (value) => {
    terminalRuntime = value;
  },
  getMessageStreamRuntime: () => messageStreamRuntime,
  setMessageStreamRuntime: (value) => {
    messageStreamRuntime = value;
  },
  shouldSkipOpenCodeStop: () => FRONT_DOOR || ENV_SKIP_OPENCODE_START || isExternalOpenCode,
  getOpenCodePort: () => openCodePort,
  getOpenCodeProcess: () => openCodeProcess,
  setOpenCodeProcess: (value) => {
    openCodeProcess = value;
  },
  killProcessOnPort,
  waitForPortRelease,
  getServer: () => server,
  getUiAuthController: () => uiAuthController,
  setUiAuthController: (value) => {
    uiAuthController = value;
  },
  getActiveTunnelController: () => activeTunnelController,
  setActiveTunnelController: (value) => {
    activeTunnelController = value;
  },
  tunnelAuthController,
  scheduledTasksRuntime: ownerBotScheduledTasksRuntime ?? scheduledTasksRuntime,
  beginGuestServiceShutdown,
  disposeFeatureRoutes: () => { agentStreams?.close(); globalMessageStreamHub.stop(); featureRoutesRuntime.dispose(); },
  closeAgentTransport: () => frontDoorRuntime?.close(),
  stopAllGuestServices,
  extensionSessionEvents,
  extensionServiceLifetime,
  getGuestSurfaceRuntime: () => guestSurfaceRuntime,
  getRealtimeProxyRuntime: () => realtimeProxyRuntime,
  getDictationRuntime: () => dictationRuntime,
  getRelayService: () => relayServiceInstance,
  getRelayReconcileTimer: () => relayReconcileTimer,
  getSpacesHost: () => spacesHost,
  getBotsHost: () => botsHost ?? botExecutionServices ?? botChildServer,
  getNotificationCenter: () => notificationCenter,
  stopFolderWatches: async () => {
    stopEnterprisePolicyWatch();
    featureRoutesRuntime.stopFolderWatches();
    await managedConfigRuntime?.cleanupExternalBridge();
  },
});

const gracefulShutdown: typeof gracefulShutdownRuntime.gracefulShutdown = (...args) => gracefulShutdownRuntime.gracefulShutdown(...args);

async function main(options: WebUiServerOptions = {}) {
  if (FRONT_DOOR) {
    const hostd = createHostdClient();
    projectRegistry = createProjectRegistry({
      shareProject: options.shareProject ?? ((directory) => hostd.request({ op: 'share-project', path: directory })),
      ownsProject: options.ownsProject ?? (async (directory: string) => {
        const ownership = await hostd.request({ op: 'project-owner', path: directory });
        return isRecord(ownership) && ownership.owner === 'agent';
      }),
    });
  }
  applyOutboundProxyFromEnv();
  const port = isNumber(options.port) && Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = isString(options.host) && options.host.length > 0 ? options.host : undefined;
  const effectiveBindHost = host
    || (isString(process.env.OPENCHAMBER_HOST) && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');
  if (FRONT_DOOR) frontDoorListen = { port, host: effectiveBindHost };
  if (!FRONT_DOOR) beginGuestServiceHost({
    registryDir: guestServiceRegistryDir(OPENCHAMBER_DATA_DIR),
    browserOrigins: async () => {
      const settings = await readSettingsFromDiskStrict();
      const address = server?.address();
      return serverBrowserOrigins({
        settingsOrigins: settings.serverBrowserOpenChamberOrigins,
        port: address && !isString(address) ? address.port : port,
        host: effectiveBindHost,
        addresses: ['0.0.0.0', '::'].includes(effectiveBindHost)
          ? Object.values(os.networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address))
          : [],
      });
    },
  });
  const instanceDir = await prepareInstanceDir({ fsPromises, path, dataDir: OPENCHAMBER_DATA_DIR });
  agentToolRuntime = FRONT_DOOR ? null : createAgentToolRuntime({
    mcpToolsRuntime,
    crypto,
    fsPromises,
    path,
    instanceDir,
    env: process.env,
    executeAction: (...args) => requireLocalRuntime(openChamberControlService, 'Control service').execute(...args),
    executeBotAction: (request, requestOptions) => requireLocalRuntime(botChildServer ?? botExecutionServices ?? botsHost, 'Bot tools').handleTool(request, requestOptions),
    resolveSessionDirectory: (sessionID) => requireLocalRuntime(openChamberControlService, 'Control service').resolveSessionDirectory(sessionID),
    getActivePort: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.port : null;
    },
    getActiveHost: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.address : null;
    },
  });
  limitFailoverRuntime = FRONT_DOOR ? null : createLimitFailoverRuntime({
    fsPromises,
    path,
    instanceDir,
    dataDir: OPENCHAMBER_DATA_DIR,
    readSettings: () => readSettingsFromDiskMigrated(),
    authorizeRequest: (req) => {
      if (!agentToolRuntime) throw new TypeError("Cannot read properties of null (reading 'authorizeRequest')");
      return agentToolRuntime.authorizeRequest(req);
    },
    broadcastUiEvent: (event) => broadcastOpenChamberUiEvent(event),
  });
  const getOpenCodePluginDelivery = () => openCodePluginDelivery({
    external: isExternalOpenCode || ENV_SKIP_OPENCODE_START,
    origin: ENV_CONFIGURED_OPENCODE_HOST?.origin || openCodeBaseUrl || null,
    ownsConfigFile: managedConfigRuntime?.ownsConfigFile() ?? true,
  });
  managedConfigRuntime = FRONT_DOOR ? null : createManagedConfigRuntime({
    fsPromises,
    path,
    instanceDir,
    dataDir: OPENCHAMBER_DATA_DIR,
    env: process.env,
    agentToolRuntime,
    limitFailoverRuntime,
    readSettings: () => readSettingsFromDiskMigrated(),
    isBotToolAvailable: () => Boolean(botsHost || botExecutionServices || botChildServer),
    listExtensionSkillDirectories: guestAgentContext.skillDirectories,
    listExtensionPluginDirectories: guestAgentContext.pluginDirectories,
    openchamberVersion: OPENCHAMBER_VERSION,
    readPluginDenials: () => pluginSwitchStore.denials(),
    getOpenCodePluginDelivery,
  });
  stopEnterprisePolicyWatch = watchEnterprisePolicy({
    onChange: () => {
      managedConfigRuntime?.refreshManagedConfigFile().catch((error) => {
        console.warn('Failed to rewrite the managed OpenCode config after a policy change:', error?.message ?? error);
      });
      broadcastOpenChamberUiEvent({ type: 'openchamber:guests-changed' });
    },
  });
  if (!FRONT_DOOR) await ensureChatsDir({ fsPromises, chatsDir: OPENCHAMBER_CHATS_DIR, warn: (message) => console.warn(`[data-dir] ${message}`) });

  const requestReachedLanAddress = (req: Request) => {
    const raw = isString(req?.socket?.localAddress) ? req.socket.localAddress : '';
    const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return null;
    if (address.startsWith('127.')) return null;
    return address;
  };
  const advertisedLanUrl = readAdvertisedLanUrl();
  const resolvePairingTransports = (req: Request) => {
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const local = `http://127.0.0.1:${activePort}`;
    if (advertisedLanUrl) {
      return { local, lan: advertisedLanUrl, relayAvailable: !relayBlockedByEnterprise() };
    }
    let lanHost: string | null = null;
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      lanHost = requestReachedLanAddress(req);
      try {
        if (!lanHost) {
          for (const list of Object.values(os.networkInterfaces())) {
            for (const entry of (list || [])) {
              if (entry.family === 'IPv4' && !entry.internal) { lanHost = entry.address; break; }
            }
            if (lanHost) break;
          }
        }
      } catch {
        lanHost = null;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') lanHost = effectiveBindHost;
    }
    const lan = lanHost ? `http://${lanHost.includes(':') ? `[${lanHost}]` : lanHost}:${activePort}` : null;
    return { local, lan, relayAvailable: !relayBlockedByEnterprise() };
  };
  const resolveDirectLanUrls = (req: Request) => {
    if (advertisedLanUrl) return [advertisedLanUrl];
    const activePort = tunnelRuntimeContext.getActivePort() || port;
    const urls: string[] = [];
    const push = (host: string | null | undefined) => {
      if (!isString(host) || !host) return;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${activePort}`;
      if (!urls.includes(url)) urls.push(url);
    };
    if (isNetworkExposedBindHost(effectiveBindHost)) {
      push(requestReachedLanAddress(req));
      try {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const entry of (list || [])) {
            if (entry.family === 'IPv4' && !entry.internal) push(entry.address);
          }
        }
      } catch {
        return urls;
      }
    } else {
      const h = String(effectiveBindHost || '').toLowerCase();
      if (h && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') push(effectiveBindHost);
    }
    return urls;
  };
  const uiPassword = isString(options.uiPassword)
    ? options.uiPassword
    : (isString(process.env.OPENCHAMBER_UI_PASSWORD) ? process.env.OPENCHAMBER_UI_PASSWORD : null);
  const uiPasswordHash = options.uiPasswordHash !== undefined
    ? options.uiPasswordHash
    : (isString(process.env.OPENCHAMBER_UI_PASSWORD_HASH) ? process.env.OPENCHAMBER_UI_PASSWORD_HASH : null);
  if (
    isNetworkExposedBindHost(effectiveBindHost)
    && !isUiAuthConfigured({ password: uiPassword, passwordHash: uiPasswordHash })
    && !isUnsafeUnauthenticatedLanAllowed(process.env)
  ) {
    throw new Error(getUnauthenticatedLanErrorMessage(effectiveBindHost));
  }
  if (FRONT_DOOR && !isUiAuthConfigured({ password: uiPassword, passwordHash: uiPasswordHash })) throw new Error('Front door requires UI password authentication.');
  if (isNetworkExposedBindHost(effectiveBindHost) && isNetworkAccessBlocked()) {
    throw new Error(NETWORK_ACCESS_BLOCKED_ERROR);
  }
  const tryCfTunnel = options.tryCfTunnel === true;
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.OPENCHAMBER_API_ONLY);
  const shouldUseCanonicalTunnelConfig = isString(options.tunnelMode)
    || isString(options.tunnelProvider)
    || options.tunnelConfigPath === null
    || isString(options.tunnelConfigPath)
    || isString(options.tunnelToken)
    || isString(options.tunnelHostname);
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: isString(options.tunnelToken) ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = isCallback(options.onTunnelReady) ? options.onTunnelReady : null;
  if (isBoolean(options.exitOnShutdown)) {
    exitOnShutdown = options.exitOnShutdown;
  }
  if (isCallback(options.onDesktopNotification)) {
    notificationEmitterRuntime.setOnDesktopNotification(options.onDesktopNotification);
  }
  if (isCallback(options.getIsWindowFocused)) {
    notificationTriggerRuntime.setGetIsWindowFocused(options.getIsWindowFocused);
  }
  const getDesktopRuntimeConfig = isCallback(options.getDesktopRuntimeConfig)
    ? options.getDesktopRuntimeConfig
    : null;
  const desktopUpdater = options.desktopUpdater
    && isCallback(options.desktopUpdater.check)
    && isCallback(options.desktopUpdater.install)
    && isCallback(options.desktopUpdater.restart)
    ? options.desktopUpdater
    : null;

  console.log(`Starting OpenChamber on port ${port === 0 ? 'auto' : port}`);

  const sayTTSCapability = detectSayTtsCapability(process);

  const hostOpenCodeClient = () => {
    const options = { baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() };
    return agentUpstream ? OpenCode.make({ ...options, fetch: agentUpstream.fetch }) : createOpenCodeClient(options);
  };
  spaceArchive = createSpaceArchive({
    dataDir: OPENCHAMBER_DATA_DIR,
    hostOpenCode: {
      importChat: (chat) => hostOpenCodeClient().experimental.session.import(chat),
      removeChat: (sessionID) => hostOpenCodeClient().session.remove({ sessionID }),
    },
  });

  const readSshHostSetting = async () => {
    const sshHost = (await readSettingsFromDiskMigrated().catch(() => null))?.isolatedSpacesSshHost;
    return isString(sshHost) ? sshHost : undefined;
  };
  const agentHostCredentials = agentUpstream ? createAgentHostCredentials(agentUpstream) : null;
  const buildSpacesHost = async () => createSpacesHost({
    frontDoor: agentUpstream ?? false,
    hostProviders: agentHostCredentials?.hostProviders,
    readHostSecret: agentHostCredentials?.readHostSecret,
    dataDir: OPENCHAMBER_DATA_DIR,
    dockerPath: searchPathFor('docker', buildAugmentedPath()) ?? 'docker',
    sshDockerHost: dockerHostOf(await readSshHostSetting()),
    colimaPath: searchPathFor('colima', buildAugmentedPath()),
    findProgram: (name) => searchPathFor(name, buildAugmentedPath()) ?? null,
    gitPath: searchPathFor('git', buildAugmentedPath()) ?? 'git',
    hostEnvironment: { ...process.env, PATH: buildAugmentedPath() },
    listProjectDirectories: async () => {
      const settings = await readSettingsFromDiskMigrated();
      return (sanitizeProjects(settings?.projects || []) ?? []).map((project) => project.path);
    },
    readIdleStop: async () => readIdleStopSetting((await readSettingsFromDiskMigrated())?.isolatedSpacesIdleStop),
    saveIdleStop: (setting) => persistSettings({ isolatedSpacesIdleStop: setting }),
    readPermissionDefault: async () => permissionDefaultOf((await readSettingsFromDiskMigrated())?.permissionDefaultMode),
    archive: spaceArchive,
    userAgent: `OpenChamber/${OPENCHAMBER_VERSION}`,
  });
  const startupSettings = await readSettingsFromDiskMigrated().catch(() => null);
  if (FRONT_DOOR) await requireLocalRuntime(settingsMirror, 'Settings mirror').start(startupSettings ?? {});
  if (AGENT_SERVER) await trustAgentProjects(startupSettings ?? {});
  if (!AGENT_SERVER && startupSettings?.isolatedSpacesEnabled === true) {
    try {
      spacesHost = await buildSpacesHost();
    } catch (error) {
      console.error(`[spaces] isolated spaces are unavailable this start: ${isRecord(error) ? error.code ?? '' : ''} ${isRecord(error) ? error.message ?? error : error}`.trim());
      spacesHost = null;
    }
  }

  const app = express();
  if (FRONT_DOOR) app.use((req, res, next) => {
    const pathname = normalizedRequestUrl(req)?.pathname.toLowerCase() ?? '';
    if (pathname === AGENT_PROTECTED_MCP_ROUTE || pathname.startsWith(`${AGENT_PROTECTED_MCP_ROUTE}/`)) return res.status(403).json({ code: 'front_door_refused' });
    next();
  });
  if (FRONT_DOOR) app.use(frontDoorRequestGate);
  if (AGENT_SERVER) app.use((req, res, next) => {
    const url = normalizedRequestUrl(req);
    const pathname = url?.pathname.toLowerCase() ?? '';
    if (/^\/api\/(?:push|protected-mcp|spaces)(?:\/|$)/.test(pathname)
      || /^\/api\/openchamber\/(?:relay|tunnel|spaces)(?:\/|$)/.test(pathname)
      || /^\/api\/openchamber\/update(?:-|\/|$)/.test(pathname) && req.method !== 'GET') {
      return res.status(403).json({ code: 'agent_feature_disabled', error: 'This feature is owned by the front door.' });
    }
    next();
  });
  const serverStartedAt = new Date().toISOString();
  const packagedClientOrigins = new Set([
    'openchamber-ui://app',
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
  ]);
  const allowLocalDevOrigins = allowsLocalDevOrigins(process.env);
  const frameAncestorsPolicy = buildFrameAncestorsPolicy({
    allowLocalDevOrigins,
    extra: process.env.OPENCHAMBER_FRAME_ANCESTORS,
  });
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!req.path.startsWith('/api/preview/proxy/')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', frameAncestorsPolicy);
    }
    next();
  });
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  app.use((req, res, next) => {
    const origin = isString(req.headers.origin) ? req.headers.origin : '';
    if (packagedClientOrigins.has(origin) || (allowLocalDevOrigins && isLocalDevClientOrigin(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,CF-Access-Client-Id,CF-Access-Client-Secret,X-OpenChamber-Surface,X-OpenChamber-Provider,X-OpenChamber-Model,X-OpenChamber-Part-Shells,X-OpenChamber-Operation-Id');
      res.setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
      // external: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age Chromium caps the preflight cache lifetime at 2 hours.
      res.setHeader('Access-Control-Max-Age', '7200');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.use(compression({
    filter: (req: Request, res: Response) => {
      if (shouldSkipCompression(req, res)) return false;
      return compression.filter(req, res);
    },
    threshold: 1024,
  }));
  expressApp = app;
  server = http.createServer(app);
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 126_000;
  gracefulShutdownRuntime.trackServerConnections(server);
  if (isNetworkExposedBindHost(effectiveBindHost)) {
    server.on('connection', (socket) => {
      if (!isLoopbackBindHost(socket.remoteAddress ?? '') && isNetworkAccessBlocked()) socket.destroy();
    });
  }
  let tunnelRuntimeContextHolder: ReturnType<typeof tunnelWiringRuntime.initialize> | ReturnType<typeof createAgentTunnelContext> | null = null;

  const bootstrapResult = bootstrapRuntime.setupBaseRoutes(app, {
    frontDoor: FRONT_DOOR,
    afterApiAuth: (auth) => {
      registerBotConversationGuards(app, () => botsHost,
        FRONT_DOOR ? () => requireLocalRuntime(agentUpstream, 'Agent upstream').json('/api/message-queue') : null);
      if (AGENT_SERVER && !isInsideBotSpace) botExecutionServices?.artifacts.registerRoutes(app, 'agent');
      limitFailoverRuntime?.registerUiRoutes(app, express);
      if (AGENT_SERVER) registerSpaceTransferRoutes(app, { agent: true, readSettings: readSettingsFromDiskMigrated, dataDir: OPENCHAMBER_DATA_DIR, resolveGitPath: resolveGitBinaryForSpawn,
        resolveTransferSource: (source, options) => requireLocalRuntime(botExecutionServices, 'Bot execution').worktrees.resolveTransferSource(source, options) });
      registerBotServiceRoutes(app, { agentServer: AGENT_SERVER && !isInsideBotSpace, services: botExecutionServices });
      registerFixLoopServiceRoutes(app, { agentServer: AGENT_SERVER, readSettings: readSettingsFromDiskMigrated,
        gitServices: () => requireLocalRuntime(featureRoutesRuntime.fixLoopGitServices(), 'Fix-loop Git services'), getOctokit: exactFixLoopOctokit,
        readFeedback: async (input) => (await import('./lib/github/pr-feedback.js')).readPullFeedback(input),
        readAuthorPermission: async (input) => (await import('./lib/github/pr-feedback.js')).readFeedbackAuthorPermission(input),
        readFailedChecks: async (input) => (await import('./lib/github/pr-feedback.js')).readFailedChecks(input),
        dataDir: OPENCHAMBER_DATA_DIR, resolveGitPath: resolveGitBinaryForSpawn });
      if (!FRONT_DOOR) return;
      spaceArchive = requireLocalRuntime(spaceArchive, 'Space archive');
      app.use(spaceArchive.guard);
      const upstream = requireLocalRuntime(agentUpstream, 'Agent upstream');
      frontDoorRuntime = createFrontDoor({ upstream, getSpacesHost: () => spacesHost, hub: globalMessageStreamHub, uiAuthController: auth, isRequestOriginAllowed });
      app.use(frontDoorRuntime.middleware);
      app.get(['/api/global/event', '/api/event'], frontDoorRuntime.serveEvents);
      requireLocalRuntime(server, 'HTTP server').prependListener('upgrade', frontDoorRuntime.upgradeHandler);
      agentStreams = createAgentStreams({
        upstream,
        onControlConnection: (connectionId) => { void requireLocalRuntime(frontDoorTrackedItems, 'Tracked items').setControlConnection(connectionId).catch(() => {}); },
        isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
        isOwnerFixLoopIdentity: (id) => prFixLoopRuntime.ownsIdentity(id),
        broadcastUiEvent: (event) => {
          broadcastOpenChamberUiEvent(event);
          if (event.type === 'openchamber:page-waiting') void maybeSendPushForTrigger(event);
          if (event.type === 'openchamber:page-settled') resolveCenterEntries({ sessionId: event.properties.sessionID, kinds: ['question'], requestId: event.properties.pageID });
        },
        broadcastGlobalUiEvent: (event) => {
          broadcastPermissionUiEvent(event);
          if (event.type === 'openchamber:notification') void notificationTriggerRuntime.deliverAgentNotification(event).catch(() => console.warn('[agent-streams] notification_delivery_failed'));
        },
      });
    },
    openChamberControlService,
    sanitizeProjects: sanitizeProjectList,
    validateDirectoryPath,
    process,
    openchamberVersion: OPENCHAMBER_VERSION,
    runtimeName: process.env.OPENCHAMBER_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    readOpenCodeLoad: () => readOpenCodeLoad({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
    getHealthSnapshot: () => {
      const launchSpec = resolvedOpencodeBinary && !useWslForOpencode && !isExternalOpenCode
        ? resolveManagedOpenCodeLaunchSpec(resolvedOpencodeBinary)
        : null;
      return {
        openCodePort,
        openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
        openCodeSecureConnection: isOpenCodeConnectionSecure(),
        openCodeAuthSource: openCodeAuthSource || null,
        openCodeApiPrefix: '',
        openCodeApiPrefixDetected: true,
        isOpenCodeReady,
        lastOpenCodeError,
        lastOpenCodeLaunchDiagnostics,
        lastOpenCodeHealthFailure,
        lastManagedOpenCodeProcess,
        lastOpenCodeRestartDiagnostics,
        opencodeBinaryResolved: resolvedOpencodeBinary || null,
        opencodeBinarySource: isExternalOpenCode ? (openCodeLifecycleRuntime.isConnectedViaSharedService() ? 'shared-service' : 'external') : resolvedOpencodeBinarySource || null,
        opencodeLaunchBinary: launchSpec?.binary || null,
        opencodeLaunchArgs: launchSpec?.args || [],
        opencodeLaunchWrapperType: launchSpec?.wrapperType || null,
        opencodeViaWsl: useWslForOpencode,
        opencodeWslBinary: resolvedWslBinary || null,
        opencodeWslPath: resolvedWslOpencodePath || null,
        opencodeWslDistro: resolvedWslDistro || null,
        nodeBinaryResolved: resolvedNodeBinary || null,
        bunBinaryResolved: resolvedBunBinary || null,
        desktopNotifyEnabled: ENV_DESKTOP_NOTIFY,
        apiOnly,
      };
    },
    getServerPort: () => {
      const activePort = tunnelRuntimeContextHolder?.getActivePort?.();
      if (isNumber(activePort) && Number.isFinite(activePort) && activePort > 0) return activePort;
      return Number.isFinite(port) && port > 0 ? port : null;
    },
    getTunnelUrl: () => tunnelRuntimeContextHolder?.tunnelService?.getPublicUrl?.() ?? null,
    verboseRequestLogs: OPENCHAMBER_VERBOSE_REQUEST_LOGS,
    uiPassword,
    uiPasswordHash,
    tunnelAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    getRelayPairingCandidate: (options) => {
      if (!relayServiceInstance) return null;
      return options?.ensureEnabled
        ? relayServiceInstance.ensureEnabledForPairing()
        : relayServiceInstance.getPairingCandidate();
    },
    reconcileRelay: () => (relayServiceInstance ? relayServiceInstance.reconcile() : Promise.resolve()),
    removeClientPushDevices: clientPushAccess.removeDevicesOfClients,
    getPairingTransports: resolvePairingTransports,
    getDirectCandidateUrls: resolveDirectLanUrls,
    getServerId: () => (relayServiceInstance ? relayServiceInstance.getServerId() : Promise.resolve(null)),
    getServerLabel: () => {
      try {
        const name = os.hostname();
        return isString(name) && name.trim().length > 0 ? name.trim() : 'OpenChamber';
      } catch {
        return 'OpenChamber';
      }
    },
    readSettingsFromDiskMigrated,
    normalizeTunnelSessionTtlMs,
    sayTTSCapability,
    ensurePushInitialized,
    ensureGlobalWatcherStarted,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    addOrUpdateApnsToken,
    removeApnsToken,
    updateUiVisibility,
    clearPendingPushBadge: () => clearPendingPushBadge(),
    clearSessionPushNotifications: notificationTriggerRuntime.clearSessionPushNotifications,
    isUiVisible,
    getUiNotificationClients: () => uiNotificationClients,
    writeSseEvent,
    pluginNotificationEmitter,
    sessionRuntime,
    setPushInitialized,
    fs,
    os,
    path,
    server,
    cliEntry: fileURLToPath(new URL('../bin/cli.js', import.meta.url)),
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    modelsDevApiUrl: MODELS_DEV_API_URL,
    modelsMetadataCacheTtl: MODELS_METADATA_CACHE_TTL,
    fetchFreeZenModels,
    getCachedZenModels,
    setAutoAcceptSession,
    notificationCenter,
    isLocalOnlyPushRequest: (req, uiSessionToken) => clientPushAccess.isLocalOnlyRequest(req, uiSessionToken),
    agentToolRuntime,
    limitFailoverRuntime,
    registerExternalBridgeRoutes: (expressApp) => managedConfigRuntime?.registerExternalBridgeRoutes(expressApp),
    desktopUpdater,
    getOpenCodeCompatibility,
    skipBodyParsing: (req) => FRONT_DOOR ? ['agent', 'space'].includes(classify(req)) : spacesHost?.skipsBodyParsing(req) === true,
  });
  uiAuthController = bootstrapResult.uiAuthController;
  app.use(spaceArchive.guard);
  app.use((req, res, next) => (spacesHost ? spacesHost.middleware(req, res, next) : next()));
  server.prependListener('upgrade', (req, ...args) => {
    if (!FRONT_DOOR || classify(req) === 'space') spacesHost?.upgradeHandler(req, ...args);
  });
  const startSpacesHost = (host: NonNullable<typeof spacesHost>) => {
    host.prepareUpgrades({ uiAuthController, isRequestOriginAllowed });
    void host.startEvents(globalMessageStreamHub, { broadcastUiEvent: broadcastOpenChamberUiEvent, broadcastGlobalUiEvent: broadcastPermissionUiEvent }).catch((error) => {
      console.warn(`[spaces] could not follow the spaces: ${error?.message ?? error}`);
    });
  };
  if (spacesHost) startSpacesHost(spacesHost);
  const spacesSwitch = createSwitchController({
    getHost: () => spacesHost,
    setHost: (host) => { spacesHost = host; },
    buildHost: buildSpacesHost,
    startHost: startSpacesHost,
    persist: (enabled) => persistSettings({ isolatedSpacesEnabled: enabled }),
    persistMachine: (machine) => persistSettings({ isolatedSpacesSshHost: machine }),
  });
  if (!AGENT_SERVER) registerSpaceRoutes(app, {
    getJourney: () => spacesHost?.journey ?? null,
    getPlaces: () => spacesHost?.places() ?? [],
    getDockerSetup: () => (spacesHost ? { placeId: spacesHost.localPlaceId, setup: spacesHost.dockerSetup } : null),
    readSwitch: spacesSwitch.readSwitch,
    setSwitch: spacesSwitch.setSwitch,
    setMachine: spacesSwitch.setMachine,
    getArchive: () => spaceArchive,
    getUiPasskeys: (req) => uiAuthController?.passkeyCredentials?.(req) ?? { rpID: null, passkeys: [] },
  });
  app.get(SPACE_TASK_TITLE_ROUTE, async (_req, res) => {
    if (!insideSpaceTaskNaming) return res.status(404).json({ error: 'This server is not inside an isolated space.' });
    res.json(await insideSpaceTaskNaming.read());
  });
  realtimeProxyRuntime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig,
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed,
  });

  const ownerTunnelRuntimeContext = AGENT_SERVER ? null : tunnelWiringRuntime.initialize(app, port, isUiAuthConfigured({ password: uiPassword, passwordHash: uiPasswordHash }));
  const tunnelRuntimeContext = AGENT_SERVER ? createAgentTunnelContext() : requireLocalRuntime(ownerTunnelRuntimeContext, 'Owner tunnels');
  const { tunnelService, startTunnelWithNormalizedRequest } = tunnelRuntimeContext;
  tunnelRuntimeContextHolder = tunnelRuntimeContext;

  const relayService = AGENT_SERVER ? null : createRelayService({
    crypto,
    readSettingsFromDiskMigrated,
    updateSettingsFromDisk: settingsRuntime.updateSettingsFromDisk,
    relayKeyStore,
    getLocalPort: () => requireLocalRuntime(ownerTunnelRuntimeContext, 'Owner tunnels').getActivePort(),
    hostLock: createRelayHostLock({
      lockFilePath: path.join(OPENCHAMBER_DATA_DIR, 'relay-host.lock'),
      fs,
      process,
    }),
    onShareState: (shareId) => {
      void sharePagesRuntime?.handleShareState(shareId).catch(() => undefined);
    },
    allowPassiveHost: process.env.OPENCHAMBER_RELAY_HOST === 'on'
      || (process.env.OPENCHAMBER_RELAY_HOST !== 'off' && process.env.OPENCHAMBER_ELECTRON_DEV !== '1'),
    hasRelayDemand: async () => {
      const [pendingRelay, deviceRelay] = await Promise.allSettled([
        clientPairingRuntime.hasActiveRelaySession(),
        remoteClientAuthRuntime.hasActiveRelayClients(),
      ]);
      if (pendingRelay.status === 'fulfilled' && pendingRelay.value) return true;
      if (deviceRelay.status === 'fulfilled' && deviceRelay.value) return true;
      if (pendingRelay.status === 'rejected') throw pendingRelay.reason;
      if (deviceRelay.status === 'rejected') throw deviceRelay.reason;
      return false;
    },
  });
  relayServiceInstance = relayService;
  relayService?.registerRoutes(app, server);
  if (!FRONT_DOOR) {
    registerSharePageRoutes(app, requireLocalRuntime(sharePagesRuntime, 'Shared pages'));
    registerReceivedPageRoutes(app, requireLocalRuntime(receivedPagesRuntime, 'Received pages'));
  }

  registerBrowserControlRoutes(app, { express, broker: browserControlBroker, preferredClient: browserClientEvents.preferredClient });
  registerUploadRoute(app, { store: browserUploadStore });

  const devServerScanner = createDevServerScanner({ spawn, platform: process.platform });
  const listDevServers = () => devServerScanner.discover({
    ownPorts: [port, openCodePort].filter((value): value is number => isNumber(value) && Number.isInteger(value) && value > 0),
  });

  if (!FRONT_DOOR) createDevTunnelRuntime({
    server,
    discoverDevServers: listDevServers,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    logger: console,
  });

  if (!FRONT_DOOR) registerSessionProjectRoutes(app, {
    validateDirectoryPath,
    openCodeTrust,
    registerSessionProject: settingsRuntime.registerSessionProject,
    resolveSessionDirectory: async (sessionID) => (await openCodeSessionClient().session.get({ sessionID })).location.directory,
    moveSession: (sessionID, directory) => openCodeSessionClient().session.move({ sessionID, directory }),
    emitWorktreeChanged: ({ directories, at }) => {
      for (const client of uiOpenChamberEventClients) {
        try {
          writeSseEvent(client, { type: 'openchamber:worktree-changed', properties: { directories, at } });
        } catch {
          uiOpenChamberEventClients.delete(client);
        }
      }
    },
  });
  if (FRONT_DOOR) registerFrontDoorFixLoopRoutes(app, { runtime: prFixLoopRuntime, services: requireLocalRuntime(agentFixLoopServices, 'Agent fix-loop services'), upstream: requireLocalRuntime(agentUpstream, 'Agent upstream'),
    withCreation: requireLocalRuntime(frontDoorFixLoopAdmission, 'Fix-loop admission'),
    isSpaceSession: (id) => Boolean(spacesHost?.index.claimedBy(id)),
    readDefaults: async () => (await readSettingsFromDiskMigrated())?.prFixLoopDefaults ?? {},
    listProjectDirectories: async () => (await listConfiguredProjects()).map((project) => project.path) });
  if (FRONT_DOOR) featureRoutesRuntime.registerFrontDoorRoutes(app, {
    agentUpstream: requireLocalRuntime(agentUpstream, 'Agent upstream'),
    frontDoorTrackedItems: requireLocalRuntime(frontDoorTrackedItems, 'Tracked items'),
    protectedMcpMirror: requireLocalRuntime(protectedMcpMirror, 'Protected MCP mirror'),
    botsServer: botsHost,
    os,
    path,
    fsPromises,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    openchamberVersion: OPENCHAMBER_VERSION,
    listConfiguredProjects,
    getOpenChamberEventClients: () => uiOpenChamberEventClients,
    writeSseEvent,
    readSettingsFromDiskMigrated,
    formatSettingsResponse,
    persistSettings,
    readCustomThemesFromDisk,
    saveImportedTheme,
    deleteImportedTheme,
    refreshOpenCodeAfterConfigChange,
  });
  else await featureRoutesRuntime.registerRoutes(app, {
    agentServer: AGENT_SERVER,
    environmentStore,
    environmentRuntime: requireLocalRuntime(environmentRuntime, 'Environment'),
    listConfiguredProjects,
    messageSearchRuntime: requireLocalRuntime(messageSearchRuntime, 'Message search'),
    sessionWarmingRuntime: requireLocalRuntime(sessionWarmingRuntime, 'Session warming'),
    sessionTodosRuntime: requireLocalRuntime(sessionTodosRuntime, 'Session todos'),
    scheduledWorktreeBridge,
    crypto,
    fs,
    os,
    path,
    fsPromises,
    spawn,
    resolveGitBinaryForSpawn,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    openchamberVersion: OPENCHAMBER_VERSION,
    isOpenCodeRunning: () => Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
    isLocalMcpScopeSupported: () => !isExternalOpenCode && !ENV_SKIP_OPENCODE_START,
    onGuestDeactivated: async (event) => {
      guestSurfaceRuntime?.endForGuest(event.guestId);
      setGuestConfigurationNote(event.guestId, null);
      if (guestMarks.clearGuest(event.guestId)) announceGuestMarksChanged();
      if (event.removed) await guestInstructions.remove(event.guestId);
      return requireLocalRuntime(browserControlRouter, 'Browser control').handleGuestDeactivated(event);
    },
    onExtensionSessionEventsChanged: async () => {
      await Promise.all([
        extensionSessionEvents?.reconcile(),
        extensionServiceLifetime?.reconcile(),
        managedConfigRuntime?.refreshManagedConfigFile(),
      ]);
    },
    onExtensionWaitsChanged: () => extensionWaitsRuntime?.reconcile(),
    getOpenCodePluginDelivery,
    extensionNotificationChannels,
    surfaceViewerHeaders: (guestId, viewerId) => guestSurfaceRuntime?.viewerHeaders(guestId, viewerId) ?? null,
    isRequestOriginAllowed,
    builtInExtensionsDir: options.builtInExtensionsDir,
    openchamberUserConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
    managedChatsRoot: OPENCHAMBER_CHATS_DIR,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    validateDirectoryPath,
    customThemesDir: OPENCHAMBER_USER_THEMES_DIR,
    readCustomThemesFromDisk,
    saveImportedTheme,
    deleteImportedTheme,
    refreshOpenCodeAfterConfigChange,
    getOpenCodeResolutionSnapshot,
    getOpenCodeUpgradeCapability,
    getOpenCodeCompatibility,
    installOpenCodeV2: async () => {
      const binary = await installOpenCodeV2({
        env: { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() },
      });
      await persistSettings({ opencodeBinary: binary });
      await refreshOpenCodeAfterConfigChange('OpenCode v2 installation');
      await waitForOpenCodeReady();
    },
    upgradeOpenCodeCli: () => {
      const sharedServiceCli = getSharedServiceCliBinary();
      const launch = resolveManagedOpenCodeLaunchSpec(sharedServiceCli || lastOpenCodeLaunchDiagnostics?.sourceBinary || resolvedOpencodeBinary);
      const upgrade = () => runOpenCodeCliUpgrade(launch, { env: { ...getLoginShellEnvSnapshot(), ...process.env, PATH: buildManagedOpenCodePath() }, cwd: os.homedir() });
      // external: https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files Windows cannot replace the running executable; the managed process stops during installation.
      if (sharedServiceCli || process.platform !== 'win32') return upgrade();
      return restartOpenCode('opencode-upgrade', { whileStopped: upgrade });
    },
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    persistResolvedSettings: (...args) => settingsRuntime.persistResolvedSettings(...args),
    sanitizeProjects: sanitizeProjectList,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort,
    getOwnPorts: () => [port, openCodePort].filter((value): value is number => isNumber(value) && Number.isInteger(value) && value > 0),
    getActivePort: () => {
      const address = server?.address?.();
      return address && !isString(address) && Number.isInteger(address.port) ? address.port : null;
    },
    getActiveHost: () => {
      const address = server?.address?.();
      return address && !isString(address) ? address.address : null;
    },
    devServerScanner,
    buildAugmentedPath,
    projectConfigRuntime: requireLocalRuntime(projectConfigRuntime, 'Project configuration'),
    projectContextRuntime: requireLocalRuntime(projectContextRuntime, 'Project context'),
    agentMemoryRuntime: requireLocalRuntime(agentMemoryRuntime, 'Agent memory'),
    isAgentMemoryEnabled,
    sessionKnowledgeRuntime: requireLocalRuntime(sessionKnowledgeRuntime, 'Session knowledge'),
    scheduledTasksRuntime: requireLocalRuntime(scheduledTasksRuntime, 'Scheduled tasks'),
    scheduledTaskService: requireLocalRuntime(scheduledTaskService, 'Scheduled task service'),
    suggestedTasksRuntime: requireLocalRuntime(suggestedTasksRuntime, 'Suggested tasks'),
    botsServer: botChildServer ?? botsHost,
    mcpToolsRuntime,
    autoResumeRuntime: requireLocalRuntime(autoResumeRuntime, 'Auto resume'),
    openChamberSessionService: requireLocalRuntime(openChamberSessionService, 'Session service'),
    openChamberControlService: requireLocalRuntime(openChamberControlService, 'Control service'),
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
    getOpenChamberEventClients: () => uiOpenChamberEventClients,
    writeSseEvent,
    globalEventHub: globalMessageStreamHub,
    permissionAutoAcceptRuntime: requireLocalRuntime(permissionAutoAcceptRuntime, 'Permission auto-accept'),
    worktreeBootstrapStore,
    messageQueueRuntime: requireLocalRuntime(messageQueueRuntime, 'Message queue'),
    prStackRestackRuntime,
    prFixLoopRuntime,
    autoReviewRuntime: requireLocalRuntime(autoReviewRuntime, 'Auto review'),
    prWatchRuntime,
    extensionWaitsRuntime,
    laterPagesRuntime,
    routingRuntime: requireLocalRuntime(routingRuntime, 'Model routing'),
    mergeFollowRuntime,
    workflowRuntime,
  });
  void extensionServiceLifetime?.reconcile();
  if (!FRONT_DOOR) registerDisplayMetadataRoute(app, {
    readSettingsFromDisk: readSettingsFromDiskMigrated,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    resolveGitBinaryForSpawn,
    resolvePrimaryWorktreeRoot,
    chatRoots: [OPENCHAMBER_CHATS_DIR],
  });
  registerAgentProtectedMcpRoutes(app, {
    agentServer: AGENT_SERVER,
    dataDir: OPENCHAMBER_DATA_DIR,
    listProjectDirectories: async () => (await listConfiguredProjects()).map((project) => project.path),
  });
  registerHostCredentialRoutes(app, {
    agentServer: AGENT_SERVER,
    credentialSource: openCodeCredentialSource({ buildOpenCodeUrl, getOpenCodeAuthHeaders }),
    listProjectDirectories: async () => (await listConfiguredProjects()).map((project) => project.path),
  });
  if (FRONT_DOOR) void startOwnerBots();

  guestSurfaceRuntime = FRONT_DOOR ? null : createGuestSurfaceRuntime({
    server,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    persistPath: extensionsPersistPath(OPENCHAMBER_DATA_DIR),
    findGuest: (id) => findInstalledGuest(id, extensionsPersistPath(OPENCHAMBER_DATA_DIR)),
    idleStopMs: BROWSER_PROVIDER_IDLE_MS,
  });

  const startupPipelineResult = await startupPipelineRuntime.run({
    frontDoor: FRONT_DOOR,
    fetchImpl: agentUpstream?.fetch ?? fetch,
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    globalEventHub: globalMessageStreamHub,
    processForwardedEventPayload,
    messageStreamWsClients: uiNotificationWsClients,
    upstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
    terminalHeartbeatIntervalMs: TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    terminalRebindWindowMs: TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    terminalMaxRebindsPerWindow: TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
    environmentRuntime,
    broadcastUiEvent: broadcastOpenChamberUiEvent,
    setupProxy,
    scheduleOpenCodeApiDetection,
    bootstrapOpenCodeAtStartup,
    onListenerReady: async () => {
      try { await featureRoutesRuntime.publishRepositoryCredentialEndpoint(); }
      catch (error) { console.warn('Git credential helper endpoint was not published:', error instanceof Error ? error.message : String(error)); }
    },
    triggerHealthCheck,
    staticRoutesRuntime,
    process,
    crypto,
    normalizeTunnelBootstrapTtlMs,
    readSettingsFromDiskMigrated,
    tunnelAuthController,
    startTunnelWithNormalizedRequest,
    gracefulShutdown,
    getSignalsAttached: () => signalsAttached,
    setSignalsAttached: (value) => {
      signalsAttached = value;
    },
    syncToHmrState,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    host,
    port,
    startupTunnelRequest: AGENT_SERVER ? null : startupTunnelRequest,
    onTunnelReady,
    tunnelRuntimeContext,
    attachSignals,
    apiOnly,
    dictationModelsDir: path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'speech-models'),
  });
  terminalRuntime = startupPipelineResult.terminalRuntime;
  dictationRuntime = startupPipelineResult.dictationRuntime;
  messageStreamRuntime = startupPipelineResult.messageStreamRuntime;
  await managedConfigRuntime?.syncExternalBridge().catch((error) => console.warn('[ExternalOpenCodePlugin] Failed to sync runtime bridge:', (isRecord(error) && error.message) || error));

  memoryDreaming?.start();

  void relayService?.reconcile();

  relayReconcileTimer = relayService ? setInterval(() => {
    void relayService.reconcile();
  }, 60_000) : null;
  relayReconcileTimer?.unref?.();

  const spaceIdleStopFile = process.env.OPENCHAMBER_SPACE_IDLE_STOP_FILE;
  if (spaceIdleStopFile) {
    startIdleStop({
      settingsPath: spaceIdleStopFile,
      readSessionStates: () => sessionRuntime.getSessionStateSnapshot(),
      readPendingRequests: () => sessionRuntime.getPendingBlockingRequestsSnapshot(),
      stopSpace: async () => {
        await gracefulShutdown({ exitProcess: false }).catch(() => {});
        process.exit(SPACE_IDLE_EXIT_CODE);
      },
    });
  }

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => tunnelRuntimeContext.getActivePort(),
    getOpenCodePort: () => openCodePort,
    getTunnelUrl: () => tunnelService.getPublicUrl(),
    getQuitRiskStatus: () => ({
      tunnel: {
        active: Boolean(tunnelService.getPublicUrl()),
      },
      scheduledTasks: scheduledTasksRuntime?.getStatus() ?? { running: false },
    }),
    isReady: () => isOpenCodeReady,
    getManagedOpenCodePreflight: () => openCodeLifecycleRuntime.getManagedOpenCodePreflight(),
    restartOpenCode: () => restartOpenCode(),
    getOpenCodeProcessInfo: () => {
      const managed = Boolean(!FRONT_DOOR && (openCodeProcess || openCodePort) && !ENV_SKIP_OPENCODE_START && !isExternalOpenCode);
      return {
        managed,
        pid: managed && isNumber(openCodeProcess?.pid) ? openCodeProcess.pid : null,
        port: managed ? openCodePort : null,
      };
    },
    stop: (shutdownOptions: { exitProcess?: boolean } = {}) => gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false }),
  };
}

runCliEntryIfMain({
  process,
  currentFilename: fileURLToPath(new URL('./index.js', import.meta.url)),
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: TUNNEL_PROVIDER_CLOUDFLARE,
  managedLocalMode: TUNNEL_MODE_MANAGED_LOCAL,
  setExitOnShutdown: (value) => {
    exitOnShutdown = value;
  },
  startServer: main,
});
export {
  gracefulShutdown,
  setupProxy,
  restartOpenCode,
  main as startWebUiServer,
  parseServeCliOptions as parseArgs,
};
