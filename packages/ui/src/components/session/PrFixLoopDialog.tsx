import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_PR_FIX_LOOP_CONFIG, fixLoopConfigSchema, isFixLoopConfigLocked, isFixLoopWorkerReady, parseFixLoopAuthors, type FixLoop, type FixLoopPull } from '@/lib/prFixLoop';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { prFixLoopStore, usePrFixLoopStore } from '@/stores/usePrFixLoopStore';
import { useUIStore } from '@/stores/useUIStore';
import { PrFixLoopConfigFields } from './PrFixLoopConfigFields';
import { PrFixLoopWorkerSetup, type WorkerSelection } from './pr-fix-loop/PrFixLoopWorkerSetup';

type Target = { kind: 'create'; context: SourceControlReadContext; sessionId: string; pull: FixLoopPull }
  | { kind: 'edit'; loop: FixLoop };

export function PrFixLoopDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const { runtime } = useRuntimeAPIs();
  React.useEffect(() => subscribeRuntimeEndpointWillChange(onClose), [onClose]);
  if (runtime.isVSCode) return null;
  return <PrFixLoopDialogBody target={target} onClose={onClose} />;
}

function PrFixLoopDialogBody({ target, onClose }: { target: Target; onClose: () => void }) {
  const { t } = useI18n();
  const mobile = useUIStore((state) => state.isMobile);
  const settingsOpen = useUIStore((state) => state.isSettingsDialogOpen);
  React.useEffect(() => { if (settingsOpen) onClose(); }, [onClose, settingsOpen]);
  const accessOpen = useSpacesStore((state) => state.accessDialog !== null);
  const currentLoop = usePrFixLoopStore((state) => target.kind === 'edit' ? state.loops.find((loop) => loop.id === target.loop.id) : undefined);
  const pendingReceipt = target.kind === 'edit' && Boolean((currentLoop ?? target.loop).pendingApproval);
  const configLocked = target.kind === 'edit' && isFixLoopConfigLocked(currentLoop ?? target.loop);
  const [config, setConfig] = React.useState(() => {
    if (target.kind === 'edit') return target.loop.config;
    const saved = fixLoopConfigSchema.partial().safeParse(useUIStore.getState().prFixLoopDefaults);
    return saved.success ? { ...DEFAULT_PR_FIX_LOOP_CONFIG, ...saved.data } : DEFAULT_PR_FIX_LOOP_CONFIG;
  });
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [selection, setSelection] = React.useState<WorkerSelection>({ worker: null, ready: false });
  const [runtimeKey] = React.useState(getRuntimeKey);
  const formRef = React.useRef<HTMLFormElement>(null);
  const valid = fixLoopConfigSchema.safeParse(config).success;
  const workerReady = target.kind === 'edit' || config.pushMode === 'auto' || selection.ready;

  const submit = async (form: HTMLFormElement) => {
    if (busy || !valid || !workerReady || configLocked || runtimeKey !== getRuntimeKey()) return;
    if (target.kind === 'edit' && isFixLoopConfigLocked(prFixLoopStore.getState().loops.find((loop) => loop.id === target.loop.id) ?? target.loop)) return;
    // Enter can submit without blurring the focused text field first.
    const fields = new FormData(form);
    const submitted = {
      ...config,
      allowAuthors: parseFixLoopAuthors(String(fields.get('allowAuthors') ?? '')),
      blockAuthors: parseFixLoopAuthors(String(fields.get('blockAuthors') ?? '')),
      mentionText: String(fields.get('mentionText') ?? ''),
    };
    if (submitted.mentionOnly && !submitted.mentionText.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      const store = prFixLoopStore.getState();
      if (target.kind === 'edit') await store.update(target.loop.id, submitted);
      else if (submitted.pushMode === 'approval') {
        if (!selection.worker || !isFixLoopWorkerReady(selection.worker, useSpacesStore.getState().journey?.get(selection.worker.spaceId), {
          sessionId: target.sessionId, directory: target.context.directory,
        })) return;
        await store.create({ ...target.pull, context: target.context, sessionId: target.sessionId, config: { ...submitted, pushMode: 'approval' }, workerId: selection.worker.id });
      } else await store.create({ ...target.pull, context: target.context, sessionId: target.sessionId, config: { ...submitted, pushMode: 'auto' } });
      if (runtimeKey === getRuntimeKey()) onClose();
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      if (runtimeKey === getRuntimeKey()) setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const title = t(target.kind === 'edit' ? 'prFixLoop.dialog.edit' : 'prFixLoop.action.start');
  const body = <form ref={formRef} className="@container min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
    <fieldset disabled={busy || configLocked} className="min-w-0">
      <PrFixLoopConfigFields config={config} executionModeLocked={target.kind === 'edit'} onChange={(patch) => {
        if (patch.pushMode && patch.pushMode !== config.pushMode) setSelection({ worker: null, ready: false });
        setConfig((current) => ({ ...current, ...patch }));
      }} disabled={busy || configLocked} />
    </fieldset>
    {target.kind === 'edit' ? <p className="typography-meta text-muted-foreground">{t(pendingReceipt ? 'prFixLoop.config.receiptLocked' : configLocked ? 'prFixLoop.config.reviewLocked' : 'prFixLoop.config.modeLocked')}</p> : null}
    {target.kind === 'create' && config.pushMode === 'approval' ? <fieldset disabled={busy} className="min-w-0">
      <PrFixLoopWorkerSetup target={{ ...target.pull, context: target.context, sessionId: target.sessionId }} onSelect={setSelection} />
    </fieldset> : null}
  </form>;
  const footer = <div className="flex w-full flex-col gap-3">
    {failed ? <p role="alert" className="typography-meta text-status-error">{t(target.kind === 'edit' ? 'prFixLoop.error.action' : 'prFixLoop.error.activation')}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" size={mobile ? 'lg' : 'sm'} disabled={busy} onClick={onClose}>{t('dialog.common.actions.cancel')}</Button>
      <Button size={mobile ? 'lg' : 'sm'} disabled={busy || !valid || !workerReady || configLocked} aria-busy={busy} onClick={() => formRef.current?.requestSubmit()}>
        {t(busy ? 'prFixLoop.action.saving' : target.kind === 'edit' ? 'prFixLoop.action.save' : 'prFixLoop.action.start')}
      </Button>
    </div>
  </div>;
  return <Dialog open modal={!accessOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85dvh] max-w-lg overflow-hidden">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t('prFixLoop.dialog.description')}</DialogDescription></DialogHeader>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" disableHorizontal>{body}</ScrollableOverlay>
      <DialogFooter>{footer}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
