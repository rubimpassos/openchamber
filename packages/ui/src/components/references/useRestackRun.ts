import * as React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { RestackRun } from '@/lib/api/types';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { latestRestackRun } from '@/lib/source-control/restackState';

/** Repository-scoped live state, recovered on mount/reconnect. A failed read retains the previous run. */
export function useRestackRun(directory: string) {
  const { sourceControl } = useRuntimeAPIs();
  const runtime = getRuntimeKey();
  const [run, setRun] = React.useState<RestackRun | null>(null);
  const currentRun = React.useRef<RestackRun | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const generation = React.useRef(0);
  const mutations = React.useRef(0);
  const accept = React.useCallback((incoming: RestackRun) => {
    if (getRuntimeKey() === runtime) {
      mutations.current += 1;
      const next = latestRestackRun(currentRun.current, incoming);
      if (next !== currentRun.current) { currentRun.current = next; setRun(next); }
    }
  }, [runtime]);
  const refresh = React.useCallback(async () => {
    const request = generation.current;
    const revision = mutations.current;
    try {
      const result = await sourceControl.prStackRestackGet(directory);
      if (request !== generation.current || getRuntimeKey() !== runtime) return;
      // An empty GET begun before an event cannot erase that event's run.
      if (result.run) accept(result.run);
      else if (revision === mutations.current) { currentRun.current = null; setRun(null); }
      setError(null);
      setStatus('ready');
    } catch (failure) {
      if (request === generation.current && getRuntimeKey() === runtime) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setStatus('error');
      }
    }
  }, [accept, directory, runtime, sourceControl]);
  React.useEffect(() => {
    let active = true;
    const stopRuntime = subscribeRuntimeEndpointWillChange(() => { generation.current += 1; active = false; currentRun.current = null; setRun(null); setError(null); setStatus('loading'); });
    void refresh();
    const stopEvents = subscribeOpenchamberEvents((event) => {
      if (!active || getRuntimeKey() !== runtime) return;
      if (event.type === 'openchamber:pr-stack.restack') {
        const incoming = event.properties.run;
        if (incoming.directory === directory || incoming.id === currentRun.current?.id) accept(incoming);
      }
      if (event.type === 'event-stream-ready') void refresh();
    });
    return () => { active = false; generation.current += 1; stopEvents(); stopRuntime(); };
  }, [accept, directory, refresh, runtime]);
  return { run, error, status, refresh, accept };
}
