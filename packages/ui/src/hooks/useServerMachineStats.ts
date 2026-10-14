import React from 'react';

import { desktopHostMachineStats } from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { parseServerMachineSample, type ServerMachineSample } from '@/lib/serverMachineStats';

const HISTORY_LIMIT = 60;
// Mirrors CPU_BASELINE_MAX_AGE_MS in packages/web/server/lib/system-stats/collect.js.
const SERVER_CPU_BASELINE_MAX_AGE_MS = 60_000;

export type ServerMachineStatsState =
  | { kind: 'loading' }
  // The server predates /api/system/stats.
  | { kind: 'unsupported' }
  | { kind: 'unavailable'; checkedAt: number }
  | {
    kind: 'ready';
    sample: ServerMachineSample;
    cpuHistory: number[];
    memoryHistory: number[];
    // Round trip of the last request; null when it included the server's
    // one-off CPU baseline wait, which would read as a fake ping spike.
    latencyMs: number | null;
    lastSuccessAt: number;
    // Set while the server stops answering: the panel keeps the last reading
    // and says how old it is instead of going blank.
    failingSince: number | null;
    checkedAt: number;
  };

const appendHistory = (history: number[], value: number | null): number[] => {
  if (value === null) return history;
  const next = history.length >= HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT + 1) : history.slice();
  next.push(value);
  return next;
};

type FetchOutcome =
  | { kind: 'sample'; sample: ServerMachineSample; latencyMs: number }
  | { kind: 'unsupported' }
  | { kind: 'failed' };

export const nextMachineStatsState = (
  prev: ServerMachineStatsState,
  outcome: FetchOutcome,
  checkedAt: number,
): ServerMachineStatsState => {
  if (outcome.kind !== 'sample') {
    // A server that answered before and stops now is down, not old.
    if (prev.kind === 'ready') return { ...prev, failingSince: prev.failingSince ?? checkedAt, checkedAt };
    return outcome.kind === 'unsupported' ? { kind: 'unsupported' } : { kind: 'unavailable', checkedAt };
  }
  // The server re-takes its CPU baseline after a minute of silence.
  const baselineFresh = prev.kind === 'ready' && checkedAt - prev.lastSuccessAt < SERVER_CPU_BASELINE_MAX_AGE_MS;
  return {
    kind: 'ready',
    sample: outcome.sample,
    cpuHistory: appendHistory(prev.kind === 'ready' ? prev.cpuHistory : [], outcome.sample.cpu.usagePercent),
    memoryHistory: appendHistory(prev.kind === 'ready' ? prev.memoryHistory : [], outcome.sample.memory.usedPercent),
    latencyMs: baselineFresh ? outcome.latencyMs : null,
    lastSuccessAt: checkedAt,
    failingSince: null,
    checkedAt,
  };
};

const fetchSample = async (signal: AbortSignal): Promise<FetchOutcome> => {
  const startedAt = performance.now();
  try {
    const response = await runtimeFetch('/api/system/stats', { headers: { Accept: 'application/json' }, signal });
    if (response.status === 404) return { kind: 'unsupported' };
    if (!response.ok) return { kind: 'failed' };
    // An older server forwards the unknown route to OpenCode, which answers
    // with something that is not a stats sample.
    const sample = parseServerMachineSample(await response.json().catch(() => null));
    if (!sample) return { kind: 'unsupported' };
    return { kind: 'sample', sample, latencyMs: performance.now() - startedAt };
  } catch {
    return { kind: 'failed' };
  }
};

/**
 * Polls the connected server's machine stats while `enabled`. `intervalMs` can
 * change without losing history; switching runtime endpoints starts over.
 * Polling pauses while the window is hidden.
 */
export const useServerMachineStats = (enabled: boolean, intervalMs: number): ServerMachineStatsState => {
  const [state, setState] = React.useState<ServerMachineStatsState>({ kind: 'loading' });
  const [endpointEpoch, setEndpointEpoch] = React.useState(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setState({ kind: 'loading' });
    setEndpointEpoch((epoch) => epoch + 1);
  }), []);

  const unsupported = state.kind === 'unsupported';

  React.useEffect(() => {
    if (!enabled || unsupported) return;

    const controller = new AbortController();
    let timer: number | null = null;

    const poll = async () => {
      if (document.visibilityState === 'visible') {
        const outcome = await fetchSample(controller.signal);
        if (controller.signal.aborted) return;
        setState((prev) => nextMachineStatsState(prev, outcome, Date.now()));
      }
      if (!controller.signal.aborted) {
        timer = window.setTimeout(() => void poll(), intervalMs);
      }
    };

    void poll();

    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, intervalMs, unsupported, endpointEpoch]);

  return state;
};

/**
 * Machine stats of other saved instances for the host list: read once when
 * `enabled` turns on (the menu opens) and every `intervalMs` while it stays
 * on. Nothing runs while it is off. Readings are kept per host so a host that
 * stops answering keeps its last values, dimmed.
 */
export const useOtherHostsMachineStats = (
  enabled: boolean,
  hostIds: readonly string[],
  intervalMs: number,
): Record<string, ServerMachineStatsState> => {
  const [states, setStates] = React.useState<Record<string, ServerMachineStatsState>>({});
  const idsKey = hostIds.join('\n');

  React.useEffect(() => {
    const ids = idsKey ? idsKey.split('\n') : [];
    if (!enabled || ids.length === 0) return;

    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      if (document.visibilityState === 'visible') {
        await Promise.all(ids.map(async (hostId) => {
          const result = await desktopHostMachineStats(hostId);
          if (cancelled) return;
          const outcome = result.kind === 'sample'
            ? { kind: 'sample' as const, sample: result.sample, latencyMs: 0 }
            : result;
          setStates((prev) => ({
            ...prev,
            [hostId]: nextMachineStatsState(prev[hostId] ?? { kind: 'loading' }, outcome, Date.now()),
          }));
        }));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), intervalMs);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, idsKey, intervalMs]);

  return states;
};
