/**
 * The authoritative state "Needs you" reads, gathered for the entries the
 * center holds. Each source reports null until it has answered on this
 * runtime, so a missing read never counts as "nothing pending".
 */
import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { NotificationCenterEntry } from '@/lib/notificationCenter';
import type { AttentionSources } from '@/lib/notificationCenterAttention';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getRestartInterruption } from '@/lib/sessionRestartInterruption';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { usePrFixLoopProjection, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

type RestackState = AttentionSources['restack'];

const EMPTY_RESTACK: RestackState = { statusByRunId: new Map(), readDirectories: new Set() };

/** Restack runs the center's entries name: read once per repository, then kept current by events. */
const useRestackRuns = (entries: readonly NotificationCenterEntry[]): RestackState => {
  const { sourceControl } = useRuntimeAPIs();
  const [state, setState] = React.useState<RestackState>(EMPTY_RESTACK);
  const directories = React.useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) if (entry.kind === 'restack' && entry.directory) set.add(entry.directory);
    return [...set].sort();
  }, [entries]);
  const directoriesKey = directories.join('\0');

  React.useEffect(() => {
    const runtime = getRuntimeKey();
    let active = true;
    const accept = (run: { id: string; status: string }) => setState((current) => {
      if (current.statusByRunId.get(run.id) === run.status) return current;
      return { ...current, statusByRunId: new Map(current.statusByRunId).set(run.id, run.status) };
    });
    const stopEvents = subscribeOpenchamberEvents((event) => {
      if (active && event.type === 'openchamber:pr-stack.restack' && getRuntimeKey() === runtime) accept(event.properties.run);
    });
    const stopRuntime = subscribeRuntimeEndpointWillChange(() => {
      active = false;
      setState(EMPTY_RESTACK);
    });
    for (const directory of directoriesKey ? directoriesKey.split('\0') : []) {
      void sourceControl.prStackRestackGet(directory).then((result) => {
        if (!active || getRuntimeKey() !== runtime) return;
        if (result.run) accept(result.run);
        setState((current) => (current.readDirectories.has(directory)
          ? current
          : { ...current, readDirectories: new Set(current.readDirectories).add(directory) }));
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      stopEvents();
      stopRuntime();
    };
  }, [directoriesKey, sourceControl]);

  return state;
};

/** Restart records still waiting on the user among the sessions the entries list. */
const useRestartPending = (entries: readonly NotificationCenterEntry[]): ReadonlySet<string> | null => {
  const sessionIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'restart') continue;
      if (entry.action?.type === 'sessions') ids.push(...entry.action.sessions.map((session) => session.sessionId));
      else if (entry.sessionId) ids.push(entry.sessionId);
    }
    return ids;
  }, [entries]);
  const loaded = useGlobalSessionsStore((state) => state.hasLoaded && state.status !== 'error');
  const entityById = useGlobalSessionsStore((state) => state.entityById);
  return React.useMemo(() => {
    if (!loaded) return null;
    const pending = new Set<string>();
    for (const sessionId of sessionIds) {
      const interruption = getRestartInterruption(entityById.get(sessionId));
      // `sent`: the agent was told to continue on its own; nothing waits for the user.
      if (interruption && interruption.resume?.state !== 'sent') pending.add(sessionId);
    }
    return pending;
  }, [entityById, loaded, sessionIds]);
};

const useFixLoopsAwaitingApproval = (enabled: boolean): ReadonlySet<string> | null => {
  usePrFixLoopProjection(enabled);
  const { loadState, loops } = usePrFixLoopStore(useShallow((state) => ({ loadState: state.loadState, loops: state.loops })));
  // A refresh passes through `loading` again; the loops it already held stay authoritative meanwhile.
  const [answered, setAnswered] = React.useState(false);
  React.useEffect(() => {
    if (loadState === 'ready') setAnswered(true);
    else if (loadState === 'idle' || loadState === 'error') setAnswered(false);
  }, [loadState]);
  return React.useMemo(() => (answered
    ? new Set(loops.filter((loop) => loop.status === 'waitingForPush').map((loop) => loop.id))
    : null), [answered, loops]);
};

const useAvailableUpdateVersion = (): string | null => useUpdateStore((state) => {
  // Only web and desktop ask the server about its own OpenChamber; mobile
  // tracks the app build, and a failed check proves nothing.
  if (state.runtimeType !== 'web' && state.runtimeType !== 'desktop') return null;
  if (state.lastChecked === null || state.error) return null;
  return state.available ? state.info?.version ?? '' : '';
});

export const useAttentionSources = (entries: readonly NotificationCenterEntry[]): AttentionSources => {
  const blocking = useGlobalBlockingRequestsStore(useShallow((state) => ({ hostSeeded: state.hostSeeded, bySession: state.bySession })));
  const restartPendingSessionIds = useRestartPending(entries);
  const hasFixLoopEntries = entries.some((entry) => entry.kind === 'fix-loop' && entry.requestId);
  const fixLoopsAwaitingApproval = useFixLoopsAwaitingApproval(hasFixLoopEntries);
  const restack = useRestackRuns(entries);
  const availableUpdateVersion = useAvailableUpdateVersion();
  return React.useMemo(() => ({
    blocking, restartPendingSessionIds, fixLoopsAwaitingApproval, restack, availableUpdateVersion,
  }), [availableUpdateVersion, blocking, fixLoopsAwaitingApproval, restack, restartPendingSessionIds]);
};
