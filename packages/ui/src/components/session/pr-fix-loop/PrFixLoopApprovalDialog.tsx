import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useI18n } from '@/lib/i18n';
import type { FixLoop, FixLoopApproval } from '@/lib/prFixLoop';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { prFixLoopStore, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';
import { useUIStore } from '@/stores/useUIStore';
import { PrFixLoopGitSetup } from './PrFixLoopGitSetup';
import { PrFixLoopReviewActions } from './PrFixLoopReviewActions';

const loadDiff = () => import('./PrFixLoopReceiptDiff').then((module) => module.PrFixLoopReceiptDiff);

export function PrFixLoopApprovalDialog({ loopId, directory, receipt, review, onClose }: {
  readonly loopId: string;
  readonly directory: string;
  readonly receipt: FixLoopApproval;
  readonly review: FixLoop['review'];
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const mobile = useUIStore((state) => state.isMobile);
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  React.useEffect(() => { if (settingsOpen) onClose(); }, [onClose, settingsOpen]);
  const accessOpen = useSpacesStore((state) => state.accessDialog !== null);
  const loop = usePrFixLoopStore((state) => state.loops.find((entry) => entry.id === loopId));
  const loadState = usePrFixLoopStore((state) => state.loadState);
  const recordFailed = usePrFixLoopStore((state) => state.failedLoopIds.includes(loopId));
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [comparing, setComparing] = React.useState(false);
  const [diffFailed, setDiffFailed] = React.useState(false);
  const Diff = useOnDemandComponent(comparing, loadDiff, () => { setDiffFailed(true); setComparing(false); });
  React.useEffect(() => subscribeRuntimeEndpointWillChange(onClose), [onClose]);
  const matchesInspection = (current: FixLoop | undefined) => current?.pendingApproval?.id === receipt.id
    && JSON.stringify(current.pendingApproval) === JSON.stringify(receipt) && JSON.stringify(current.review) === JSON.stringify(review);
  const matches = matchesInspection(loop);
  const canApprove = matches && loadState === 'ready' && !recordFailed && loop?.status === 'waitingForPush' && !busy;
  const approve = async () => {
    if (!canApprove) return;
    const state = prFixLoopStore.getState();
    const current = state.loops.find((entry) => entry.id === loopId);
    if (state.loadState !== 'ready' || state.failedLoopIds.includes(loopId) || current?.status !== 'waitingForPush' || !matchesInspection(current)) return;
    setBusy(true);
    setFailed(false);
    try { await prFixLoopStore.getState().approve(loopId, receipt.id); onClose(); }
    catch (error) { if (!(error instanceof Error)) throw error; setFailed(true); }
    finally { setBusy(false); }
  };
  const detail = (label: string, value: string) => <div className="min-w-0 space-y-1">
    <dt className="typography-meta text-muted-foreground">{label}</dt>
    <dd dir="ltr" className="break-all font-mono typography-meta text-foreground">{value}</dd>
  </div>;
  const body = <div className="min-w-0 space-y-4">
    <dl className="min-w-0 space-y-3">
      {detail(t('prFixLoop.approval.commit'), receipt.commit)}
      {detail(t('prFixLoop.approval.localRef'), receipt.localRef)}
      {detail(t('prFixLoop.approval.repository'), `${receipt.destination.headRepo.owner}/${receipt.destination.headRepo.repo}`)}
      {detail(t('prFixLoop.approval.headRepositoryId'), receipt.destination.headRepo.id)}
      {detail(t('prFixLoop.approval.repositoryId'), receipt.repositoryId)}
      {detail(t('prFixLoop.approval.ref'), receipt.destination.ref)}
      {detail(t('prFixLoop.approval.expectedHead'), receipt.destination.expectedHead)}
      {detail(t('prFixLoop.approval.receipt'), receipt.id)}
    </dl>
    <div className="flex flex-wrap gap-x-4 gap-y-1 typography-meta text-muted-foreground">
      <span dir="auto">{t('prFixLoop.approval.paths', { count: receipt.changedPaths })}</span>
      <span dir="auto">{t('prFixLoop.approval.bytes', { count: receipt.changedBytes })}</span>
    </div>
    {review ? <PrFixLoopReviewActions review={review} /> : null}
    <Button size="sm" variant="chip" aria-pressed={comparing} onClick={() => { setDiffFailed(false); setComparing((value) => !value); }}>{t('prFixLoop.approval.files')}</Button>
    {diffFailed ? <p role="alert" className="typography-meta text-status-error">{t('prFixLoop.approval.diffFailed')}</p> : null}
    {comparing ? Diff ? <Diff key={receipt.id} directory={directory} receipt={receipt} /> : <p role="status" className="typography-meta text-muted-foreground">{t('prFixLoop.loading')}</p> : null}
    <p className="typography-meta text-muted-foreground">{t('prFixLoop.approval.retained')}</p>
    {failed ? <PrFixLoopGitSetup directory={directory} /> : null}
  </div>;
  const footer = <div className="flex w-full flex-col gap-3">
    {!matches ? <p role="alert" className="typography-meta text-status-warning">{t('prFixLoop.approval.changed')}</p> : null}
    {failed ? <p role="alert" className="typography-meta text-status-error">{t('prFixLoop.error.publication')}</p> : null}
    {matches && loop?.status === 'stopped' ? <p className="typography-meta text-muted-foreground">{t('prFixLoop.approval.resumeFirst')}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button size={mobile ? 'lg' : 'sm'} variant="ghost" disabled={busy} onClick={onClose}>{t('dialog.common.actions.close')}</Button>
      <Button size={mobile ? 'lg' : 'sm'} disabled={!canApprove} aria-busy={busy} onClick={() => void approve()}>{t(busy ? 'prFixLoop.approval.publishing' : 'prFixLoop.approval.publish')}</Button>
    </div>
  </div>;
  const title = t('prFixLoop.approval.title');
  return <Dialog open modal={!accessOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85dvh] max-w-3xl overflow-hidden">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t('prFixLoop.approval.description')}</DialogDescription></DialogHeader>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" disableHorizontal>{body}</ScrollableOverlay>
      <DialogFooter>{footer}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
