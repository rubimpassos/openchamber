import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { PrFixLoopDialog } from '@/components/session/PrFixLoopDialog';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { Button } from '@/components/ui/button';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { PrFixLoopWorkerStatus } from '@/components/session/pr-fix-loop/PrFixLoopWorkerStatus';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { isFixLoopActive, isFixLoopConfigLocked, type FixLoop, type FixLoopApproval } from '@/lib/prFixLoop';
import { fixLoopCiState, fixLoopStatusKey, isFixLoopPrReady } from '@/lib/prFixLoopPresentation';
import { prFixLoopStore, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';

const loadApproval = () => import('@/components/session/pr-fix-loop/PrFixLoopApprovalDialog').then((module) => module.PrFixLoopApprovalDialog);
const reviewStatusKeys = {
  awaitingPublication: 'prFixLoop.review.state.awaitingPublication', pending: 'prFixLoop.review.state.pending',
  blocked: 'prFixLoop.review.state.blocked', complete: 'prFixLoop.review.state.complete',
} as const satisfies Record<NonNullable<FixLoop['review']>['state'], string>;

export const PrFixLoopRow = React.memo(function PrFixLoopRow({ loop, projectionFailed }: { loop: FixLoop; projectionFailed: boolean }) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const openTrackerItem = useOpenTrackerItem();
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [reviewed, setReviewed] = React.useState<{ readonly receipt: FixLoopApproval; readonly review: FixLoop['review'] } | null>(null);
  const ApprovalDialog = useOnDemandComponent(reviewed !== null, loadApproval, () => { setReviewed(null); setFailed(true); });
  const active = isFixLoopActive(loop);
  const recordFailed = usePrFixLoopStore((state) => state.failedLoopIds.includes(loop.id) || (projectionFailed && state.loadState === 'error'));
  const readFailed = recordFailed || Boolean(loop.lastError);
  const ci = fixLoopCiState(loop, recordFailed);
  const prReady = !readFailed && isFixLoopPrReady(loop);
  const size = isMobile ? 'lg' : 'sm';

  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try { await operation(); }
    catch (cause) { if (!(cause instanceof Error)) throw cause; setFailed(true); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-w-0 space-y-2 border-b border-border/60 px-3 py-2" role="group" aria-label={t('prFixLoop.title')}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={readFailed ? 'alert' : 'git-pull-request'} className="size-3.5 shrink-0 text-muted-foreground" />
        <span dir="ltr" className="shrink-0 text-sm tabular-nums">#{loop.number}</span>
        <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate text-sm text-foreground" title={loop.title}>{loop.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground" role="status">
        <span className={readFailed ? 'text-status-warning' : prReady ? 'text-status-success' : undefined}>
          {t(readFailed ? 'prFixLoop.status.error' : fixLoopStatusKey(loop))}
        </span>
        {prReady && loop.iterations === 0 ? null
          : <span dir="auto" className="tabular-nums">{t('prFixLoop.iterations', { current: loop.iterations, max: loop.config.maxIterations })}</span>}
        <span className={ci === 'success' ? 'text-status-success' : ci === 'failure' ? 'text-status-error' : undefined}>
          {t(`prFixLoop.ci.${ci}`)}
        </span>
        <span>{readFailed || loop.unresolvedThreads === null
          ? t('prFixLoop.threads.unknown') : t('prFixLoop.threads.count', { count: loop.unresolvedThreads })}</span>
        {!readFailed && loop.changesRequested ? <span>{t('prFixLoop.changesRequested')}</span> : null}
      </div>
      {loop.review ? <div className="min-w-0 space-y-1 typography-meta" role="status">
        <p className={loop.review.state === 'blocked' ? 'text-status-warning' : 'text-muted-foreground'}>{t(reviewStatusKeys[loop.review.state])}</p>
        <p dir="auto" className="tabular-nums text-muted-foreground">{t('prFixLoop.review.progress', { completed: loop.review.completed, total: loop.review.total })}</p>
        {loop.review.lastError ? <p dir="auto" role="alert" className="oc-ui-start-align whitespace-pre-wrap break-words text-status-warning">{loop.review.lastError}</p> : null}
      </div> : null}
      {loop.worker ? <PrFixLoopWorkerStatus worker={loop.worker} /> : null}
      {loop.lastError ? <p role="status" className="break-words typography-meta text-status-warning">{t('prFixLoop.error.retained')}</p> : null}
      {failed ? <p role="alert" className="break-words typography-meta text-status-error">{t('prFixLoop.error.retained')}</p> : null}
      <div className="flex flex-wrap items-center gap-1">
        {loop.pendingApproval ? <Button size={size} variant="chip" disabled={busy} aria-pressed={reviewed !== null}
          onClick={() => setReviewed((current) => current || !loop.pendingApproval ? null : { receipt: loop.pendingApproval, review: loop.review })}>
          {t('prFixLoop.approval.title')}
        </Button> : null}
        {active || (loop.worker && (loop.status === 'stopped' || loop.status === 'error')) ? <Button size={size} variant="ghost" disabled={busy} onClick={() => void act(() => prFixLoopStore.getState().stop(loop.id))}>
          {t('prFixLoop.action.stop')}
        </Button> : null}
        {(loop.status === 'stopped' || loop.status === 'error') && (loop.config.pushMode === 'auto' || loop.worker) ? <Button size={size} variant="outline" disabled={busy}
          onClick={() => void act(() => prFixLoopStore.getState().resume(loop.id))}>{t('prFixLoop.action.resume')}</Button> : null}
        {active ? <Button size={size} variant="chip" disabled={busy || isFixLoopConfigLocked(loop)} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
          {t('prFixLoop.action.settings')}
        </Button> : null}
        <Button size={size} variant="ghost" onClick={() => openTrackerItem(loop.url, loop.directory)}>{t('prFixLoop.action.open')}</Button>
        {!active && !loop.pendingApproval ? <Button size={size} variant="ghost" disabled={busy} onClick={() => void act(() => prFixLoopStore.getState().dismiss(loop.id))}>
          {t('prFixLoop.action.dismiss')}
        </Button> : null}
      </div>
      {editing ? <PrFixLoopDialog target={{ kind: 'edit', loop }} onClose={() => setEditing(false)} /> : null}
      {reviewed && ApprovalDialog ? <ApprovalDialog loopId={loop.id} directory={loop.directory} receipt={reviewed.receipt} review={reviewed.review} onClose={() => setReviewed(null)} /> : null}
    </div>
  );
});
