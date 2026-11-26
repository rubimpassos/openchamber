import React from 'react';

import { loadGuestServiceStatus } from '@/lib/guests/service';
import { getSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { delay } from '@/lib/timing/delay';

import {
  IDLE_SERVER_BROWSER_MONITOR,
  createServerBrowserMonitor,
  type ServerBrowserMonitor,
  type ServerBrowserMonitorSnapshot,
  type ServerBrowserServiceStatus,
} from './browserMonitor';
import {
  closeServerBrowserScope,
  getServerBrowserMemory,
  getServerBrowserState,
  type ServerBrowserResult,
} from './client';
import { browserMemoryKey, monitoredBrowsers, type MonitoredBrowser } from './monitoredBrowsers';
import { hasServerBrowserFollower, publishedServerBrowserState, useServerBrowserSharedState } from './sharedState';
import type { ServerBrowserState } from './types';

export type ServerBrowserMonitorView = ServerBrowserMonitorSnapshot & {
  readonly browsers: readonly MonitoredBrowser[];
  readonly refresh: () => void;
  readonly close: (scopeId: string) => Promise<ServerBrowserResult<ServerBrowserState>>;
};

const NO_BROWSERS: readonly MonitoredBrowser[] = [];
const MONITOR_GONE: ServerBrowserResult<ServerBrowserState> = { ok: false, error: 'The browser list is no longer shown.' };

const createStableBrowsers = () => {
  let key = '[]';
  let stable: readonly MonitoredBrowser[] = NO_BROWSERS;
  return (next: readonly MonitoredBrowser[]): readonly MonitoredBrowser[] => {
    const nextKey = JSON.stringify(next);
    if (nextKey !== key) {
      key = nextKey;
      stable = next;
    }
    return stable;
  };
};

const serviceStatusOf = async (guestId: string): Promise<ServerBrowserServiceStatus> => {
  const status = await loadGuestServiceStatus(guestId);
  if (!status.ok) return status.code === 'NO_SERVICE' ? 'stopped' : 'unknown';
  return status.result.status === 'ready' || status.result.status === 'starting' ? 'ready' : 'stopped';
};

export const useServerBrowserMonitor = (
  guestId: string | null,
  directory: string | null,
  enabled: boolean,
): ServerBrowserMonitorView => {
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const provider = enabled ? guestId : null;
  const project = enabled ? directory : null;

  const selectBrowsers = React.useMemo(() => {
    if (!provider || !project) return () => NO_BROWSERS;
    const stable = createStableBrowsers();
    return (shared: ReturnType<typeof useServerBrowserSharedState.getState>) => (
      stable(monitoredBrowsers(publishedServerBrowserState(shared, provider, runtimeKey), project))
    );
  }, [project, provider, runtimeKey]);
  const browsers = useServerBrowserSharedState(selectBrowsers);

  const [snapshot, setSnapshot] = React.useState(IDLE_SERVER_BROWSER_MONITOR);
  const owner = React.useMemo(
    () => ({ provider, project, runtimeKey, monitor: React.createRef<ServerBrowserMonitor>() }),
    [provider, project, runtimeKey],
  );

  React.useEffect(() => {
    const { provider: ownerProvider, project: ownerProject, runtimeKey: ownerRuntime } = owner;
    if (!ownerProvider || !ownerProject) return undefined;
    const shared = () => useServerBrowserSharedState.getState();
    const monitor = createServerBrowserMonitor({
      currentState: () => publishedServerBrowserState(shared(), ownerProvider, ownerRuntime),
      publishState: (state) => shared().publish(ownerProvider, ownerRuntime, state),
      clearState: () => shared().clear(ownerProvider),
      watch: () => {
        const reading = shared();
        const shown = monitoredBrowsers(publishedServerBrowserState(reading, ownerProvider, ownerRuntime), ownerProject);
        return {
          memoryKey: browserMemoryKey(shown),
          agentActive: shown.some((browser) => browser.agentActive),
          loading: shown.some((browser) => browser.loading),
          panelFollows: hasServerBrowserFollower(reading, ownerProvider),
        };
      },
      serviceStatus: () => serviceStatusOf(ownerProvider),
      readState: (waitFor) => getServerBrowserState(ownerProvider, getSurfaceViewerId(ownerProvider), waitFor),
      readMemory: () => getServerBrowserMemory(ownerProvider, getSurfaceViewerId(ownerProvider)),
      closeScope: (body) => closeServerBrowserScope(ownerProvider, getSurfaceViewerId(ownerProvider), body),
      now: Date.now,
      wait: delay,
      isCurrent: captureRuntimeInstance(),
    });
    const ownedMonitor = owner.monitor;
    ownedMonitor.current = monitor;
    const stopSnapshots = monitor.subscribe(() => setSnapshot(monitor.getSnapshot()));
    const stopState = useServerBrowserSharedState.subscribe(monitor.stateChanged);
    const stopEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'browser-agent-activity' && event.guestId === ownerProvider) monitor.agentActed();
    });
    monitor.stateChanged();
    void monitor.refresh();
    return () => {
      stopSnapshots();
      stopState();
      stopEvents();
      monitor.dispose();
      ownedMonitor.current = null;
      setSnapshot(IDLE_SERVER_BROWSER_MONITOR);
    };
  }, [owner]);

  const refresh = React.useCallback(() => { void owner.monitor.current?.refresh(); }, [owner]);
  const close = React.useCallback(
    (scopeId: string) => owner.monitor.current?.close(scopeId) ?? Promise.resolve(MONITOR_GONE),
    [owner],
  );

  return { ...snapshot, browsers, refresh, close };
};
