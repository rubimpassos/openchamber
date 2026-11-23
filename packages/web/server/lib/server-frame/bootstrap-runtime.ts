import { registerNotificationEmitRoutes } from '../notifications/emit-route.js';
import { registerIntegrationControlRoutes } from '../integration-control/routes.js';
import { registerHttpResponseDiagnostics } from './core-routes.js';
import type {
  AuthAndAccessDependencies,
  CommonRequestDependencies,
  ServerStatusDependencies,
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './core-routes.js';
import type { Application, ExpressFactory } from '../shared/http-contracts.js';
import type { createAgentToolRuntime } from '../agent-tool/runtime.js';
import type { createLimitFailoverRuntime } from '../limit-failover/runtime.js';
import type { registerNotificationRoutes } from '../notifications/routes.js';
import type { OpenChamberRouteDependencies, registerOpenChamberRoutes } from '../self-update/openchamber-routes.js';
import type { SayTtsCapability } from '../tts/capability-runtime.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';

type AgentTool = Pick<ReturnType<typeof createAgentToolRuntime>, 'authorizeRequest' | 'registerRoutes'>;
type Notifications = Parameters<typeof registerNotificationRoutes>[1];
type SessionSnapshots = Pick<Notifications, 'getSessionActivitySnapshot' | 'getSessionStateSnapshot' |
  'getPendingBlockingRequestsSnapshot' | 'getSessionContextSnapshot' | 'getSessionState'>;
type SayTtsDependencies = { sayTTSCapability: Promise<SayTtsCapability> };

interface BootstrapDependencies {
  createUiAuth: typeof createUiAuth;
  registerServerStatusRoutes: typeof registerServerStatusRoutes;
  registerCommonRequestMiddleware: typeof registerCommonRequestMiddleware;
  registerAuthAndAccessRoutes: typeof registerAuthAndAccessRoutes;
  registerTtsRoutes: (app: Application, dependencies: SayTtsDependencies) => void;
  registerNotificationRoutes: typeof registerNotificationRoutes;
  registerOpenChamberRoutes: typeof registerOpenChamberRoutes;
  registerAgentToolRoutes?: (app: Application, dependencies: { express: ExpressFactory; agentToolRuntime: AgentTool }) => void;
  express: ExpressFactory;
}

type BaseRoutesOptions =
  & Required<Omit<ServerStatusDependencies, 'express' | 'uiAuthController' | 'tunnelAuthController'>>
  & Required<Omit<AuthAndAccessDependencies, 'express' | 'uiAuthController'>>
  & Required<Omit<CommonRequestDependencies, 'express'>>
  & Required<Omit<Notifications, 'uiAuthController' | keyof SessionSnapshots>>
  & Required<Omit<OpenChamberRouteDependencies, 'desktopUpdater' | 'server' | 'hostInstall' | 'onUpdateAvailable'>>
  & Pick<OpenChamberRouteDependencies, 'hostInstall' | 'onUpdateAvailable'>
  & { desktopUpdater: OpenChamberRouteDependencies['desktopUpdater'] }
  & SayTtsDependencies
  & {
    uiPassword: string | null;
    uiPasswordHash?: string | null | undefined;
    server: OpenChamberRouteDependencies['server'] & NonNullable<Parameters<typeof registerIntegrationControlRoutes>[1]['server']>;
    frontDoor?: boolean;
    afterApiAuth?: (auth: ReturnType<typeof createUiAuth>) => void;
    openChamberControlService: Parameters<typeof registerIntegrationControlRoutes>[1]['controlService'] | null;
    sanitizeProjects: Parameters<typeof registerIntegrationControlRoutes>[1]['sanitizeProjects'];
    validateDirectoryPath: Parameters<typeof registerIntegrationControlRoutes>[1]['validateDirectoryPath'];
    sessionRuntime: Required<SessionSnapshots>;
    agentToolRuntime: AgentTool | null;
    limitFailoverRuntime: Pick<ReturnType<typeof createLimitFailoverRuntime>, 'registerRoutes'> | null;
    registerExternalBridgeRoutes?: (app: Application) => void;
    pluginNotificationEmitter: Parameters<typeof registerNotificationEmitRoutes>[1]['emitter'];
  };

export const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    registerAgentToolRoutes = () => {},
    express,
  } = dependencies;

  const setupBaseRoutes = (app: Application, options: BaseRoutesOptions) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      readOpenCodeLoad,
      getServerPort,
      getTunnelUrl,
      verboseRequestLogs,
      uiPassword,
      uiPasswordHash,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      removeClientPushDevices,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      updateSettingsFromDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      clearSessionPushNotifications,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      cliEntry,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      notificationCenter,
      isLocalOnlyPushRequest,
      agentToolRuntime,
      limitFailoverRuntime,
      registerExternalBridgeRoutes,
      pluginNotificationEmitter,
      desktopUpdater,
      getOpenCodeCompatibility,
      skipBodyParsing,
      openChamberControlService,
      sanitizeProjects,
      validateDirectoryPath,
    } = options;

    registerHttpResponseDiagnostics(app);

    const uiAuthOptions: Parameters<typeof createUiAuth>[0] = {
      password: uiPassword,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
    };
    if (uiPasswordHash != null) uiAuthOptions.passwordHash = uiPasswordHash;
    const uiAuthController = createUiAuth(uiAuthOptions);
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    if (!options.frontDoor) {
      if (!openChamberControlService) throw new Error('Integration control requires the project control service');
      registerIntegrationControlRoutes(app, {
        controlService: openChamberControlService,
        readSettingsFromDiskMigrated,
        sanitizeProjects,
        validateDirectoryPath,
        server,
      });
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      getServerPort,
      getTunnelUrl,
      tunnelAuthController,
      uiAuthController,
      readOpenCodeLoad,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs, skipBodyParsing });

    if (!options.frontDoor && agentToolRuntime) registerAgentToolRoutes(app, { express, agentToolRuntime });
    limitFailoverRuntime?.registerRoutes(app, express);

    const notificationEmitRoutes = registerNotificationEmitRoutes(app, {
      express,
      isAgentToolRequestAuthorized: (req) => agentToolRuntime?.authorizeRequest?.(req) === true,
      emitter: pluginNotificationEmitter,
    });
    notificationEmitRoutes.registerPluginRoute();

    const { requireApiAuth } = registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      removeClientPushDevices,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    options.afterApiAuth?.(uiAuthController);

    notificationEmitRoutes.registerApiRoute(requireApiAuth);

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      updateSettingsFromDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      clearSessionPushNotifications,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getPendingBlockingRequestsSnapshot: sessionRuntime.getPendingBlockingRequestsSnapshot,
      getSessionContextSnapshot: sessionRuntime.getSessionContextSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      setPushInitialized,
      setAutoAcceptSession,
      notificationCenter,
      isLocalOnlyPushRequest,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      cliEntry,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
      desktopUpdater,
      getOpenCodeCompatibility,
    });

    registerExternalBridgeRoutes?.(app);

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
