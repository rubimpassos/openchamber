import * as React from 'react';
import { toast } from '@/components/ui';
import { useGitOperationRecovery } from '@/components/views/git/useGitOperationRecovery';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullRequestRef, PullStack, RestackRun, SourceControlReadContext } from '@/lib/api/types';
import { runBoundGitNetworkOperation } from '@/lib/boundGitNetworkOperation';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { publishRestack } from '@/lib/source-control/publishRestack';
import { restackBelongsToStack, restackPublicationPlan } from '@/lib/source-control/restackState';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRestackRun } from './useRestackRun';

type RunAction = 'continue' | 'abort' | 'ask-session';
type Publication = { readonly id: string; readonly heads: ReadonlyMap<string, string> };

export function useRestackActions(context: SourceControlReadContext, stack: PullStack, { pull, onChanged, enabled }: { pull: GitHubPullRequestRef; onChanged: () => void; enabled: boolean }) {
  const { sourceControl, git } = useRuntimeAPIs();
  const { t } = useI18n();
  const runtime = getRuntimeKey();
  const live = useRestackRun(context.directory);
  const run = live.run && live.run.remote === context.primaryRemote && restackBelongsToStack(live.run, stack) ? live.run : null;
  const recovery = useGitOperationRecovery(context.directory, git, sourceControl);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [publication, setPublication] = React.useState<Publication | null>(null);
  const pushed = React.useRef(new Map<string, Set<string>>());
  const autoPublished = React.useRef<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = React.useCallback(() => mounted.current && getRuntimeKey() === runtime, [runtime]);
  const reportFailure = (error: Error | string) => {
    if (isCurrent()) toast.error(t('prStacks.actionFailed'), { description: error instanceof Error ? error.message : error });
  };

  const push = React.useCallback(async (completed: RestackRun) => {
    const transfer = recovery.start();
    if (!transfer) return;
    setBusy('push');
    try {
      const result = await publishRestack({ run: completed, stack, context,
        heads: publication?.id === completed.id ? publication.heads : undefined,
        alreadyPushed: pushed.current.get(completed.id) ?? new Set(),
      }, { sourceControl, git, isCurrent: () => isCurrent() && transfer.isCurrent(), onOperation: transfer.onOperation });
      if (!isCurrent()) return;
      const successes = pushed.current.get(completed.id) ?? new Set<string>();
      result.pushed.forEach((branch) => successes.add(branch));
      pushed.current.set(completed.id, successes);
      if (result.failures.length) toast.error(t('prStacks.pushPartial', { branches: result.failures.map((failure) => failure.branch).join(', ') }), {
        description: result.failures.map((failure) => `${failure.branch}: ${failure.error ?? t('prStacks.leaseUnknown')}`).join('\n'),
      });
      else if (result.pushed.length) toast.success(t('prStacks.pushed'));
      else toast.message(t('gitView.toast.alreadyUpToDate'));
      onChanged();
    } catch (error) {
      if (isCurrent()) toast.error(t('prStacks.actionFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      transfer.finish();
      if (isCurrent()) setBusy(null);
    }
  }, [context, git, isCurrent, onChanged, publication, recovery, sourceControl, stack, t]);

  React.useEffect(() => {
    if (!enabled || busy || recovery.blocked || run?.status !== 'done' || publication?.id !== run.id || autoPublished.current === run.id) return;
    autoPublished.current = run.id;
    void push(run);
  }, [busy, enabled, publication, push, recovery.blocked, run]);

  const start = async () => {
    if (!enabled || live.status !== 'ready' || busy || recovery.blocked) return;
    const transfer = recovery.start();
    if (!transfer) return;
    setBusy('restack');
    try {
      const status = await git.getGitStatus(context.directory);
      if (!isCurrent() || !transfer.isCurrent()) return;
      await runBoundGitNetworkOperation({ action: 'fetch', directory: context.directory, remoteName: context.primaryRemote, status, sourceControl, git, onOperation: transfer.onOperation });
      if (!isCurrent() || !transfer.isCurrent()) return;
      const fresh = await sourceControl.githubPullStack(context, pull);
      if (!isCurrent()) return;
      const captured = fresh.connected ? fresh.stack : null;
      if (!captured) throw new Error(t('prStacks.stackChanged'));
      const session = useSessionUIStore.getState();
      const sessionId = session.currentSessionId && session.getDirectoryForSession(session.currentSessionId) === context.directory ? session.currentSessionId : null;
      const open = captured.members.filter((member) => member.state === 'open');
      const oldBase = open[0]?.mergedParent?.headSha;
      const started = await sourceControl.prStackRestack({ directory: context.directory, sessionId,
        remote: context.primaryRemote, trunk: open[0]?.retargetTo ?? captured.trunk, branches: open.map((member) => member.head),
        oldBase: oldBase && /^[0-9a-f]{40}$/.test(oldBase) ? oldBase : undefined,
      });
      if (!isCurrent()) return;
      setPublication({ id: started.id, heads: new Map(captured.members.map((member) => [member.head, member.headSha])) });
      live.accept(started);
    } catch (error) { reportFailure(error instanceof Error ? error : String(error)); }
    finally { transfer.finish(); if (isCurrent()) setBusy(null); }
  };

  const act = async (action: RunAction) => {
    if (!run || busy) return;
    setBusy(action);
    try {
      const methods = { continue: sourceControl.prStackRestackContinue, abort: sourceControl.prStackRestackAbort, 'ask-session': sourceControl.prStackRestackAskSession };
      const updated = await methods[action](run.id);
      if (isCurrent()) { live.accept(updated); onChanged(); }
    } catch (error) { reportFailure(error instanceof Error ? error : String(error)); }
    finally { if (isCurrent()) setBusy(null); }
  };
  const repositoryBusy = live.run && ['running', 'paused', 'waitingForSession'].includes(live.run.status);
  // Only branches GitHub still shows at their pre-restack head can be pushed;
  // one already at its new head was pushed, one moved elsewhere needs a new restack.
  const plan = run?.status === 'done' ? restackPublicationPlan(run, stack, publication?.id === run.id ? publication.heads : undefined) : null;
  const pending = Boolean(plan && plan.publish.length > 0);
  return { run, error: live.error, busy, start, act, push, pending, refresh: live.refresh, recovery,
    canStart: enabled && live.status === 'ready' && !busy && !recovery.blocked && !repositoryBusy && stack.members.some((member) => member.state === 'open'),
  };
}
