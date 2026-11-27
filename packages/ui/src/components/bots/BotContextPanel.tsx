import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import type { BotItemDetailRead } from '@/lib/botsApi';
import type { BotArtifact, BotArtifactFailure } from '@/lib/bots/artifacts';
import type { BotDefinition } from '@/lib/bots/config';
import { isTerminalBotItem, type BotItem } from '@/lib/bots/items';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BotEvidence } from './BotEvidence';
import { BotItemControls, BotItemRecord, BotItemWait } from './BotItemDetail';
import { BotStateLabel } from './BotItemList';
import { useBotArtifacts } from './useBotRequest';

const TABS = ['work', 'artifacts'] as const;
export type BotContextTab = typeof TABS[number];
const listFailureKeys = {
  failed: 'bots.artifacts.failed', unavailable: 'bots.artifacts.unavailable', network: 'bots.artifacts.network',
} satisfies Record<BotArtifactFailure, I18nKey>;
const loadArtifactView = () => import('./BotRenderArtifactView').then((module) => module.BotRenderArtifactView);

type ArtifactViewer = { readonly artifact: BotArtifact } & (
  | { readonly phase: 'preparing' | 'presented' }
  | { readonly phase: 'closing'; readonly retry: (() => void) | null }
);

export function BotArtifactList({ projectId, itemId, readOnly, read, requirements }: {
  readonly projectId: string; readonly itemId: string; readonly readOnly: boolean;
  readonly read: ReturnType<typeof useBotArtifacts>; readonly requirements: BotDefinition['artifacts'];
}) {
  const { t, locale } = useI18n();
  const [viewer, setViewer] = React.useState<ArtifactViewer | null>(null);
  const opener = React.useRef<HTMLButtonElement | null>(null);
  const [viewFailed, setViewFailed] = React.useState(false);
  const failView = () => { setViewer(null); setViewFailed(true); };
  const View = useOnDemandComponent(viewer !== null, loadArtifactView, failView);
  const preparingId = viewer?.phase === 'preparing' ? viewer.artifact.id : null;
  const ready = React.useCallback(() => setViewer((current) => (
    current === viewer && current?.phase === 'preparing' ? { artifact: current.artifact, phase: 'presented' } : current
  )), [viewer]);
  const close = (retry: (() => void) | null) => setViewer((current) => (
    current?.phase === 'presented' ? { artifact: current.artifact, phase: 'closing', retry } : current
  ));
  const closed = () => {
    if (viewer?.phase !== 'closing') return;
    if (!viewer.retry) { setViewer(null); return; }
    setViewer({ artifact: viewer.artifact, phase: 'preparing' });
    viewer.retry();
  };
  const cancel = () => { setViewer(null); opener.current?.focus(); };
  const artifacts = read.data;
  const requirementLabels = new Map(requirements.map((requirement) => [requirement.id, requirement.label]));
  const presented = new Set(artifacts?.map((artifact) => artifact.requirement));
  return <>
    {requirements.length ? <SettingsSection title={t('bots.panel.artifacts.required')} contentClassName="typography-meta">
      <ul className="space-y-1.5">{requirements.map((requirement) => <li key={requirement.id} className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 break-words typography-ui-label text-foreground" dir="auto">{requirement.label}</span>
        {artifacts ? <span className={cn('shrink-0', presented.has(requirement.id) ? 'text-[var(--status-success-text)]' : 'text-muted-foreground')}>
          {t(presented.has(requirement.id) ? 'bots.panel.artifacts.presented' : 'bots.panel.artifacts.pending')}
        </span> : null}
      </li>)}</ul>
    </SettingsSection> : null}
    <SettingsSection title={t('bots.artifacts.title')} contentClassName="space-y-2 typography-meta">
      {read.failure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-[var(--status-error-text)]">
        <span>{t(listFailureKeys[read.failure])}</span><Button size="xs" variant="outline" onClick={read.refresh}>{t('bots.retry')}</Button>
      </div> : null}
      {viewFailed ? <p role="alert" className="text-[var(--status-error-text)]">{t('bots.artifacts.viewFailed')}</p> : null}
      {!artifacts && !read.failure ? <p role="status" className="text-muted-foreground">{t('common.loading')}</p> : null}
      {artifacts?.length === 0 ? <p className="text-muted-foreground">{t('bots.panel.artifacts.empty')}</p> : null}
      {artifacts?.length ? <ul className="-mx-2 space-y-0.5">{artifacts.map((artifact) => <li key={artifact.id} className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={(event) => { opener.current = event.currentTarget; setViewFailed(false); setViewer({ artifact, phase: 'preparing' }); }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label text-foreground hover:bg-interactive-hover/50 pointer-coarse:!min-h-11 focus-visible:bg-interactive-hover/50 focus-visible:outline-none">
          <span className="min-w-0 flex-1 truncate oc-ui-start-align" dir="auto" title={artifact.title}>{artifact.title}</span>
          {artifact.requirement && requirementLabels.has(artifact.requirement) ? <span className="oc-tile-inset max-w-1/3 shrink-0 truncate rounded px-1.5 typography-micro text-muted-foreground" dir="auto" title={requirementLabels.get(artifact.requirement)}>{requirementLabels.get(artifact.requirement)}</span> : null}
          <time className="shrink-0 typography-meta text-muted-foreground" dateTime={new Date(artifact.createdAt).toISOString()}>{new Date(artifact.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</time>
        </button>
        {artifact.id === preparingId ? <>
          <span role="status" className="shrink-0 typography-meta text-muted-foreground">{t('common.loading')}</span>
          <Button size="xs" variant="ghost" onClick={cancel}>{t('settings.common.actions.cancel')}</Button>
        </> : null}
      </li>)}</ul> : null}
      <Dialog open={viewer?.phase === 'presented'} onOpenChange={(open) => { if (!open) close(null); }} onOpenChangeComplete={(open) => { if (!open) closed(); }}>
        <DialogContent staged={viewer ? viewer.phase === 'preparing' : undefined} finalFocus={() => (opener.current?.isConnected ? opener.current : true)} className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogTitle dir="auto" className="pe-8">{viewer?.artifact.title}</DialogTitle>
          {viewer && View ? <View key={viewer.artifact.id} projectId={projectId} itemId={itemId} artifactId={viewer.artifact.id} readOnly={readOnly}
            preparing={viewer.phase === 'preparing'} onReady={ready} onLoadFailed={failView} onRetry={close} /> : null}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  </>;
}

export function BotContextPanel({ projectId, item, requirements, detail, busy, failed, archived, tab, onTabChange, onRefresh, onLeave, onClose, className }: {
  readonly projectId: string; readonly item: BotItem; readonly requirements: BotDefinition['artifacts'];
  readonly detail: BotItemDetailRead | null;
  readonly busy: boolean; readonly failed: boolean; readonly archived: boolean;
  readonly tab: BotContextTab; readonly onTabChange: (tab: BotContextTab) => void;
  readonly onRefresh: () => void; readonly onLeave: () => void;
  readonly onClose?: () => void; readonly className?: string;
}) {
  const { t } = useI18n();
  const labels = { work: t('bots.context.work'), artifacts: t('bots.panel.tab.artifacts') } satisfies Record<BotContextTab, string>;
  const readOnly = archived || isTerminalBotItem(item);
  const pages = useBotArtifacts({ projectId, itemId: item.id }, tab !== 'work', !archived);
  return <aside aria-label={t('bots.context.label')} className={cn('flex min-h-0 min-w-0 flex-col', className)}>
    <div className="flex h-10 shrink-0 items-center gap-1 px-2">
      {onClose ? <Button size="sm" variant="ghost" onClick={onClose}><Icon name="arrow-left" />{t('bots.context.conversation')}</Button> : null}
      <SortableTabsStrip className="h-7 min-w-0 flex-1" variant="active-pill" activeId={tab} onSelect={(id) => onTabChange(TABS.find((entry) => entry === id) ?? 'work')}
        items={TABS.map((id) => ({ id, label: labels[id] }))} />
      {!archived ? <Tooltip>
        <TooltipTrigger asChild><Button size="sm" variant="ghost" disabled={busy} onClick={() => { onRefresh(); pages.refresh(); }} aria-label={t('bots.refresh')}><Icon name="refresh" /></Button></TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('bots.refresh')}</TooltipContent>
      </Tooltip> : null}
    </div>
    <div data-bot-context-body="" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2 @container">
      {failed ? <p role="alert" className="mb-4 typography-meta text-[var(--status-error-text)]">{t('bots.error')}</p> : null}
      <div>
        {tab === 'work' ? <>
          <SettingsSection contentClassName="space-y-4">
            {onClose ? <h2 className="break-words typography-ui-header" dir="auto">{item.title}</h2> : null}
            <p className="typography-meta"><BotStateLabel state={item.state} /> · {t('bots.tokens', { count: item.tokens.total })}</p>
            {item.description ? <p className="whitespace-pre-wrap break-words typography-ui-label" dir="auto">{item.description}</p> : null}
            <BotItemWait item={item} />
            {!archived ? <BotItemControls projectId={projectId} item={item} onChanged={onRefresh} /> : null}
          </SettingsSection>
          <BotItemRecord item={item} detail={detail} busy={busy} onLeave={onLeave} />
        </> : <>
          <BotArtifactList projectId={projectId} itemId={item.id} readOnly={readOnly} read={pages} requirements={requirements} />
          <BotEvidence item={item} />
        </>}
      </div>
    </div>
  </aside>;
}
