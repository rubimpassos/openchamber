import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { isBoolean, isRecord } from '../shared/object-guards.js';

type Cleanup = () => void | Promise<void | object>;
type Stop = { stop: Cleanup };
type OptionalStop = Partial<Stop> | null;
type Close = { close: Cleanup };
type Timer = ReturnType<typeof setInterval>;

export interface ShutdownOptions {
  exitProcess?: boolean;
}

interface ShutdownDependencies {
  process: Pick<NodeJS.Process, 'exit'>;
  shutdownTimeoutMs: number;
  getExitOnShutdown: () => boolean;
  getIsShuttingDown: () => boolean;
  setIsShuttingDown: (value: boolean) => void;
  syncToHmrState: Cleanup;
  openCodeWatcherRuntime: Stop;
  chatDirectoryCleanupRuntime?: Stop | null;
  sessionRuntime: { dispose: Cleanup };
  sessionAssistRuntime?: OptionalStop;
  sessionWorkRuntime?: OptionalStop;
  autoResumeRuntime?: OptionalStop;
  sessionGoalRuntime?: OptionalStop;
  contextObligatoryRuntime?: OptionalStop;
  sessionWarmingRuntime?: OptionalStop;
  sessionTodosRuntime?: OptionalStop;
  autoReviewRuntime?: OptionalStop;
  prWatchRuntime?: OptionalStop;
  extensionWaitsRuntime?: OptionalStop;
  mergeFollowRuntime?: OptionalStop;
  messageQueueRuntime?: OptionalStop;
  prFixLoopRuntime?: OptionalStop;
  suggestedTasksRuntime?: OptionalStop;
  dispatchResultsRuntime?: OptionalStop;
  workflowRuntime?: { shutdown: Cleanup } | null;
  messageSearchRuntime?: OptionalStop;
  scheduledTasksRuntime?: OptionalStop;
  getHealthCheckInterval: () => Timer | null;
  clearHealthCheckInterval: (value: Timer) => void;
  getTerminalRuntime: () => { shutdown: Cleanup } | null;
  setTerminalRuntime: (value: null) => void;
  getMessageStreamRuntime: () => Close | null;
  setMessageStreamRuntime: (value: null) => void;
  shouldSkipOpenCodeStop: () => boolean;
  getOpenCodePort: () => number | null;
  getOpenCodeProcess: () => Close | null;
  setOpenCodeProcess: (value: null) => void;
  killProcessOnPort: (port: number | null) => void;
  waitForPortRelease: (port: number | null, timeoutMs: number) => Promise<boolean>;
  getServer: () => Server | null;
  getUiAuthController: () => { dispose: Cleanup } | null;
  setUiAuthController: (value: null) => void;
  getActiveTunnelController: () => Stop | null;
  setActiveTunnelController: (value: null) => void;
  tunnelAuthController: { clearActiveTunnel: Cleanup };
  beginGuestServiceShutdown: Cleanup;
  stopAllGuestServices: Cleanup;
  extensionServiceLifetime?: OptionalStop;
  extensionSessionEvents?: OptionalStop;
  getGuestSurfaceRuntime: () => Stop | null;
  getRealtimeProxyRuntime: () => Stop | null;
  getDictationRuntime: () => Stop | null;
  getRelayService: () => Stop | null;
  getRelayReconcileTimer: () => Timer | null;
  getSpacesHost?: () => Close | null;
  getBotsHost?: () => Stop | null;
  getNotificationCenter?: () => Stop | null;
  disposeFeatureRoutes?: Cleanup;
  closeAgentTransport?: Cleanup;
  stopFolderWatches?: Cleanup;
}

export const createGracefulShutdownRuntime = (dependencies: ShutdownDependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    chatDirectoryCleanupRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionWorkRuntime,
    autoResumeRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    sessionWarmingRuntime,
    sessionTodosRuntime,
    autoReviewRuntime,
    prWatchRuntime,
    extensionWaitsRuntime = null,
    mergeFollowRuntime,
    messageQueueRuntime,
    prFixLoopRuntime,
    dispatchResultsRuntime,
    suggestedTasksRuntime,
    workflowRuntime = null,
    messageSearchRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    killProcessOnPort,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    beginGuestServiceShutdown,
    disposeFeatureRoutes = () => undefined,
    stopAllGuestServices,
    extensionServiceLifetime,
    extensionSessionEvents,
    getGuestSurfaceRuntime,
    getRealtimeProxyRuntime,
    getDictationRuntime,
    getRelayService,
    getRelayReconcileTimer,
    getSpacesHost = () => null,
    getBotsHost = () => null,
    getNotificationCenter = () => null,
    closeAgentTransport = () => undefined,
    stopFolderWatches = () => {},
  } = dependencies;

  let shutdownPromise: Promise<void> | null = null;
  const serverConnections = new Set<Socket>();
  let closingHttpServer = false;

  const trackServerConnections = (server: Server) => {
    const onConnection = (socket: Socket) => {
      if (closingHttpServer) {
        socket.destroy();
        return;
      }
      serverConnections.add(socket);
      socket.once('close', () => serverConnections.delete(socket));
    };
    server.on('connection', onConnection);
    server.once('close', () => server.off('connection', onConnection));
  };

  const runShutdown = async (options: ShutdownOptions = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    beginGuestServiceShutdown();
    disposeFeatureRoutes();
    // Admission to guest services closed above; stop the session-event
    // subscriber in the same tick, so no event reaches a service's refusal
    // ("the host is shutting down") and reads as a broken service entry.
    extensionSessionEvents?.stop?.();
    extensionServiceLifetime?.stop?.();
    extensionWaitsRuntime?.stop?.();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = isBoolean(options.exitProcess) ? options.exitProcess : getExitOnShutdown();
    let botCleanupFailure: unknown = null;

    const cleanupOperations = [
      () => clearInterval(getRelayReconcileTimer() ?? undefined),
      () => getGuestSurfaceRuntime()?.stop(),
      () => getRealtimeProxyRuntime()?.stop(),
      // Drain bot effects and dedicated space queues before their transports close.
      () => scheduledTasksRuntime?.stop?.(),
      () => prFixLoopRuntime?.stop?.(),
      async () => {
        try { await getBotsHost()?.stop(); }
        catch (error) {
          botCleanupFailure = error;
          const failures = error instanceof AggregateError ? error.errors : [error];
          console.error('[bots] Shutdown cleanup failed', failures.map((failure: unknown) => isRecord(failure) && typeof failure.code === 'string' && /^BOT_[A-Z0-9_]+$/.test(failure.code)
            ? failure.code : 'BOT_HOST_STOP_FAILED'));
        }
      },
      () => getNotificationCenter()?.stop(),
      // The isolated-spaces host, when the switch is on: its connections into spaces end here.
      () => getSpacesHost()?.close(),
      closeAgentTransport,
      () => getRelayService()?.stop(),
      () => getDictationRuntime()?.stop(),
      stopFolderWatches,
      () => chatDirectoryCleanupRuntime?.stop(),
      () => openCodeWatcherRuntime.stop(),
      () => sessionRuntime.dispose(),
      () => sessionAssistRuntime?.stop?.(),
      () => sessionWorkRuntime?.stop?.(),
      () => autoResumeRuntime?.stop?.(),
      () => sessionGoalRuntime?.stop?.(),
      () => contextObligatoryRuntime?.stop?.(),
      () => sessionWarmingRuntime?.stop?.(),
      () => sessionTodosRuntime?.stop?.(),
      () => autoReviewRuntime?.stop?.(),
      () => prWatchRuntime?.stop?.(),
      () => mergeFollowRuntime?.stop?.(),
      () => messageQueueRuntime?.stop?.(),
      () => dispatchResultsRuntime?.stop?.(),
      () => suggestedTasksRuntime?.stop?.(),
      () => workflowRuntime?.shutdown(),
      () => messageSearchRuntime?.stop?.(),
      stopAllGuestServices,
    ];
    for (const cleanup of cleanupOperations) {
      try {
        await cleanup();
      } catch {
        continue;
      }
    }

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
        void 0;
      } finally {
        setTerminalRuntime(null);
      }
    }

    const messageStreamRuntime = getMessageStreamRuntime();
    if (messageStreamRuntime) {
      try {
        await messageStreamRuntime.close();
      } catch {
        void 0;
      } finally {
        setMessageStreamRuntime(null);
      }
    }

    if (!shouldSkipOpenCodeStop()) {
      const portToKill = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        try {
          await openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        setOpenCodeProcess(null);
      }

      killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      closingHttpServer = true;
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            server.closeAllConnections?.();
            for (const socket of serverConnections) socket.destroy();
          }),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    if (botCleanupFailure) {
      if (exitProcess) { process.exit(1); return; }
      throw botCleanupFailure;
    }
    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  const gracefulShutdown = (options: ShutdownOptions = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
