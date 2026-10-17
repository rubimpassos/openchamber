import * as React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { GitOperationStatus } from '@/components/views/git/GitOperationStatus';
import type { GitHubPullRequestRef, PullStack, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useRestackActions } from './useRestackActions';

export function PullStackRestack({ context, stack, pull, onChanged, enabled }: {
  context: SourceControlReadContext; stack: PullStack; pull: GitHubPullRequestRef; onChanged: () => void;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const actions = useRestackActions(context, stack, { pull, onChanged, enabled });
  const { run, busy, recovery } = actions;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void actions.start()} disabled={!actions.canStart}>
          <Icon name={busy === 'restack' ? 'loader-4' : 'git-branch'} className={busy === 'restack' ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {t('prStacks.restack')}
        </Button>
        {run ? <span role="status" className="typography-meta text-muted-foreground">{t(`prStacks.run.${run.status}`)}</span> : null}
        <Button size="xs" variant="ghost" onClick={() => void actions.refresh()} aria-label={t('references.picker.preview.refresh')}>
          <Icon name="refresh" className="size-3.5" />
        </Button>
      </div>
      {actions.error ? <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{actions.error}</p> : null}
      {run ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface-muted/40 p-2 typography-meta">
          <ol className="space-y-1">
            {run.steps.map((step) => (
              <li key={step.branch} className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2">
                  <code dir="ltr" className="break-all">{step.branch}</code>
                  <span className={step.status === 'conflict' || step.status === 'failed' ? 'text-[var(--status-warning-text)]' : 'text-muted-foreground'}>{t(`prStacks.step.${step.status}`)}</span>
                </div>
                {step.error ? <p className="break-words text-[var(--status-error-text)]">{step.error}</p> : null}
                {step.worktree ? <code dir="ltr" className="block break-all text-muted-foreground">{step.worktree}</code> : null}
                {step.conflictFiles?.map((file) => <code key={file} dir="ltr" className="block break-all text-muted-foreground">{file}</code>)}
              </li>
            ))}
          </ol>
          {run.status === 'paused' || run.status === 'waitingForSession' ? (
            <>
              <p className="text-muted-foreground">{t('prStacks.conflictHint')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={Boolean(busy) || run.status !== 'paused'} onClick={() => void actions.act('continue')}>{t('prStacks.continue')}</Button>
                <Button size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => void actions.act('abort')}>{t('prStacks.abort')}</Button>
                <Button size="sm" variant="outline" disabled={Boolean(busy) || !run.sessionId || run.status !== 'paused'} onClick={() => void actions.act('ask-session')}>{t('prStacks.askSession')}</Button>
              </div>
            </>
          ) : null}
          {run.status === 'done' && actions.pending ? <Button size="sm" variant="outline" className="self-start" disabled={!enabled || Boolean(busy) || recovery.blocked} onClick={() => void actions.push(run)}>{t('prStacks.push')}</Button> : null}
        </div>
      ) : null}
      <GitOperationStatus entry={recovery.entry} onRefresh={() => void recovery.refresh()} onCancel={() => void recovery.cancel()} />
    </div>
  );
}
