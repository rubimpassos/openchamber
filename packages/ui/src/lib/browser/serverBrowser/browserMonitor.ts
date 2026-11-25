import { isServerBrowserViewChanged, type ServerBrowserResult } from './client';
import type { ServerBrowserMemory, ServerBrowserState } from './types';

export const SERVER_BROWSER_MEMORY_INTERVAL_MS = 5_000;
export const SERVER_BROWSER_HOLD_MS = 15_000;
const UNHELD_ANSWER_MS = 1_000;

export type ServerBrowserWatch = {
  readonly memoryKey: string;
  readonly agentActive: boolean;
  readonly loading: boolean;
  readonly panelFollows: boolean;
};

export type ServerBrowserServiceStatus = 'ready' | 'stopped' | 'unknown';

export type ServerBrowserMonitorSnapshot = {
  readonly memory: ServerBrowserMemory | null;
  readonly readFailed: boolean;
  readonly refreshing: boolean;
};

type ServerBrowserMonitorDependencies = {
  readonly currentState: () => ServerBrowserState | null;
  readonly publishState: (state: ServerBrowserState) => void;
  readonly clearState: () => void;
  readonly watch: () => ServerBrowserWatch;
  readonly serviceStatus: () => Promise<ServerBrowserServiceStatus>;
  readonly readState: (waitFor?: { since: string; waitMs: number }) => Promise<ServerBrowserResult<ServerBrowserState>>;
  readonly readMemory: () => Promise<ServerBrowserResult<ServerBrowserMemory>>;
  readonly closeScope: (body: { scopeId: string; generation: number }) => Promise<ServerBrowserResult<ServerBrowserState>>;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly isCurrent: () => boolean;
};

export type ServerBrowserMonitor = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ServerBrowserMonitorSnapshot;
  readonly refresh: () => Promise<void>;
  readonly stateChanged: () => void;
  readonly agentActed: () => void;
  readonly close: (scopeId: string) => Promise<ServerBrowserResult<ServerBrowserState>>;
  readonly dispose: () => void;
};

export const IDLE_SERVER_BROWSER_MONITOR: ServerBrowserMonitorSnapshot = { memory: null, readFailed: false, refreshing: false };

const routeIsMissing = (result: { readonly status?: number }): boolean => (
  result.status !== undefined && result.status >= 400 && result.status < 500 && result.status !== 409
);

export const createServerBrowserMonitor = (deps: ServerBrowserMonitorDependencies): ServerBrowserMonitor => {
  const listeners = new Set<() => void>();
  let snapshot = IDLE_SERVER_BROWSER_MONITOR;
  let disposed = false;
  let following = false;
  let refreshRun: Promise<void> | null = null;
  let stateSupported = true;
  let memoryPhase: 'idle' | 'waiting' | 'reading' = 'idle';
  let memoryDue = false;
  let memorySupported = true;
  let memorySampledAt = Number.NEGATIVE_INFINITY;
  let memoryKey = '';
  let skipMemoryWait: (() => void) | null = null;

  const update = (patch: Partial<ServerBrowserMonitorSnapshot>): void => {
    if (disposed) return;
    const next = { ...snapshot, ...patch };
    if (next.memory === snapshot.memory && next.readFailed === snapshot.readFailed && next.refreshing === snapshot.refreshing) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const runMemory = async (immediately: boolean): Promise<void> => {
    let skipWait = immediately;
    do {
      memoryDue = false;
      const remaining = memorySampledAt + SERVER_BROWSER_MEMORY_INTERVAL_MS - deps.now();
      if (!skipWait && remaining > 0) {
        memoryPhase = 'waiting';
        await Promise.race([deps.wait(remaining), new Promise<void>((resolve) => { skipMemoryWait = resolve; })]);
        skipMemoryWait = null;
      }
      skipWait = false;
      if (disposed) break;
      if (deps.watch().memoryKey === '') {
        update({ memory: null });
        continue;
      }
      memoryPhase = 'reading';
      const result = await deps.readMemory();
      memorySampledAt = deps.now();
      if (result.ok) update({ memory: result.data });
      else {
        if (routeIsMissing(result)) memorySupported = false;
        update({ memory: null });
      }
    } while (memoryDue && memorySupported && !disposed);
    memoryPhase = 'idle';
  };

  const sampleMemory = (immediately: boolean): void => {
    if (!memorySupported || disposed) return;
    if (memoryPhase === 'idle') void runMemory(immediately);
    else if (memoryPhase === 'waiting') {
      if (immediately) skipMemoryWait?.();
    } else if (!immediately) memoryDue = true;
  };

  const follow = async (expectChange: boolean): Promise<void> => {
    if (following || disposed) return;
    following = true;
    let expecting = expectChange;
    try {
      while (!disposed) {
        const watch = deps.watch();
        if (watch.panelFollows || !(expecting || watch.agentActive || watch.loading)) return;
        const version = deps.currentState()?.version;
        if (!version) return;
        const startedAt = deps.now();
        const result = await deps.readState({ since: version, waitMs: SERVER_BROWSER_HOLD_MS });
        if (disposed) return;
        if (!result.ok) {
          update({ readFailed: true });
          return;
        }
        expecting = false;
        update({ readFailed: false });
        deps.publishState(result.data);
        if (result.data.version !== version) continue;
        if (deps.now() - startedAt < UNHELD_ANSWER_MS || !deps.watch().agentActive) return;
      }
    } finally {
      following = false;
    }
  };

  const read = async (): Promise<boolean> => {
    const result = await deps.readState();
    if (disposed) return false;
    if (!result.ok && routeIsMissing(result)) {
      stateSupported = false;
      update({ readFailed: false });
      return false;
    }
    update({ readFailed: !result.ok });
    if (result.ok) deps.publishState(result.data);
    return result.ok;
  };

  const refreshOnce = async (): Promise<void> => {
    update({ refreshing: true });
    try {
      const status = await deps.serviceStatus();
      if (disposed) return;
      if (status === 'stopped') {
        deps.clearState();
        update({ memory: null, readFailed: false });
        return;
      }
      if (status === 'unknown') {
        update({ readFailed: true });
        return;
      }
      if (await read()) sampleMemory(true);
    } finally {
      refreshRun = null;
      update({ refreshing: false });
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    refresh: () => {
      if (!stateSupported) return Promise.resolve();
      refreshRun ??= refreshOnce();
      return refreshRun;
    },
    stateChanged: () => {
      if (disposed) return;
      const next = deps.watch().memoryKey;
      if (next !== memoryKey) {
        memoryKey = next;
        sampleMemory(false);
      }
      void follow(false);
    },
    agentActed: () => {
      if (disposed || !stateSupported || deps.watch().panelFollows) return;
      if (deps.currentState()?.version) void follow(true);
      else void read().then((ok) => (ok ? follow(true) : undefined));
    },
    close: async (scopeId) => {
      const unavailable: ServerBrowserResult<ServerBrowserState> = { ok: false, error: 'The browser list is no longer shown.' };
      if (disposed || !deps.isCurrent()) return unavailable;
      let result = await deps.closeScope({ scopeId, generation: deps.currentState()?.generation ?? 0 });
      if (disposed || !deps.isCurrent()) return unavailable;
      if (!result.ok && isServerBrowserViewChanged(result.error)) {
        const current = await deps.readState();
        if (disposed || !deps.isCurrent()) return unavailable;
        if (current.ok) {
          deps.publishState(current.data);
          result = await deps.closeScope({ scopeId, generation: current.data.generation });
          if (disposed || !deps.isCurrent()) return unavailable;
        }
      }
      if (result.ok && !disposed) deps.publishState(result.data);
      return result;
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
      skipMemoryWait?.();
    },
  };
};
