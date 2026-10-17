import * as React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullRequestRef, PullStack, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useReferenceRevalidation } from './referenceCache';

type StackState = {
  readonly key: string;
  readonly stack: PullStack | null;
  readonly status: 'loading' | 'ready' | 'error' | 'disconnected';
  readonly error: string | null;
};

/** Only a visible PR owns this read. No page-wide fetch, timer or persisted stack membership. */
export function usePullStack(context: SourceControlReadContext | null, pull: GitHubPullRequestRef, enabled = true) {
  const { sourceControl } = useRuntimeAPIs();
  const { owner, repo, number } = pull;
  const runtime = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const key = JSON.stringify([runtime, context, owner, repo, number]);
  const [state, setState] = React.useState<StackState>({ key: '', stack: null, status: 'loading', error: null });
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const revalidation = useReferenceRevalidation();
  const generation = React.useRef(0);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => { generation.current += 1; }), []);
  React.useEffect(() => {
    const request = ++generation.current;
    if (!context || !enabled) return;
    const isCurrent = () => generation.current === request && getRuntimeKey() === runtime;
    setState((previous) => ({ key, stack: previous.key === key ? previous.stack : null, status: 'loading', error: null }));
    void sourceControl.githubPullStack(context, { owner, repo, number }).then((result) => {
      if (!isCurrent()) return;
      setState({ key, stack: result.connected ? result.stack : null, status: result.connected ? 'ready' : 'disconnected', error: null });
    }).catch((error) => {
      if (!isCurrent()) return;
      setState((previous) => ({ key, stack: previous.key === key ? previous.stack : null, status: 'error', error: error instanceof Error ? error.message : String(error) }));
    });
    return () => { generation.current += 1; };
  }, [context, enabled, key, owner, repo, number, revalidation, revision, runtime, sourceControl]);
  React.useEffect(() => {
    if (!context || !enabled) return;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready' || (event.type === 'source-control-activity' && event.directory === context.directory)) refresh();
    });
  }, [context, enabled]);
  return { ...(state.key === key ? state : { key, stack: null, status: 'loading' as const, error: null }), refresh };
}
