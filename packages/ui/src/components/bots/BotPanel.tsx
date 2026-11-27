import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { BotWorkItem } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { BotAvatar } from './BotAvatar';
import { BotArtifactList } from './BotContextPanel';
import { BotStateLabel } from './BotItemList';
import { botWorkItemKey, describeBotReason, useBotItemActions, useBotPanelData, type BotPanelData } from '@/hooks/useBotPanel';
import { useBotPanelScope, type BotPanelScope } from '@/hooks/useBotPanelSession';
import { useBotArtifacts } from './useBotRequest';

const TABS = ['home', 'artifacts'] as const;
type BotPanelTab = typeof TABS[number];
type ItemActions = ReturnType<typeof useBotItemActions>;

const waitsOnPerson = (item: BotWorkItem) => item.state === 'needs-you' || item.state === 'waiting-answer';
const hasEnded = (item: BotWorkItem) => item.state === 'done' || item.state === 'failed' || item.state === 'stopped';

function ItemTile({ item, failure, children }: { readonly item: BotWorkItem; readonly failure: I18nKey | null; readonly children: React.ReactNode }) {
  const { t } = useI18n();
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === item.projectId));
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  return <li className="oc-tile min-w-0 space-y-2 rounded-lg p-3">
    <p className="line-clamp-2 break-words typography-ui-label text-foreground" dir="auto" title={item.title}>{item.title}</p>
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-meta text-muted-foreground">
      {project ? <><span className="min-w-0 truncate" dir="auto">{project.label?.trim() || formatDirectoryName(project.path, homeDirectory || undefined)}</span><span aria-hidden="true">·</span></> : null}
      <BotStateLabel state={item.state} />
    </p>
    {children}
    {failure ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t(failure)}</p> : null}
  </li>;
}

function OpenChatButton({ item, primary }: { readonly item: BotWorkItem; readonly primary: boolean }) {
  const { t } = useI18n();
  const { conversation } = item;
  const onScreen = useSessionUIStore((state) => conversation !== null && state.currentSessionId === conversation.sessionId);
  if (onScreen) return null;
  const button = <Button size="sm" variant={primary ? 'default' : 'outline'} disabled={!conversation}
    onClick={() => { if (conversation) useSessionUIStore.getState().setCurrentSession(conversation.sessionId, conversation.directory); }}>{t('bots.panel.openChat')}</Button>;
  return conversation ? button : <DisabledHint hint={t('bots.panel.openChat.unavailable')}>{button}</DisabledHint>;
}

function DisabledHint({ hint, children }: { readonly hint: string; readonly children: React.ReactNode }) {
  return <Tooltip>
    <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md">{children}</span></TooltipTrigger>
    <TooltipContent side="top" sideOffset={6}>{hint}</TooltipContent>
  </Tooltip>;
}

function WaitingItem({ item, actions }: { readonly item: BotWorkItem; readonly actions: ItemActions }) {
  const { t } = useI18n();
  const [confirmingStop, setConfirmingStop] = React.useState(false);
  const reason = item.wait ? describeBotReason(item.wait.reason) : null;
  return <ItemTile item={item} failure={actions.failureFor(item)}>
    {reason ? <p className="typography-meta text-foreground">{t(reason.key, reason.params)}</p> : null}
    {item.question ? <div className="oc-tile-inset space-y-1 rounded-md p-2 typography-meta">
      {item.question.questions.map((question, index) => <p key={index} className="whitespace-pre-wrap break-words text-foreground" dir="auto">{question}</p>)}
      <p className="text-muted-foreground">{t('bots.panel.asksInChat')}</p>
    </div> : null}
    {confirmingStop ? <div className="space-y-2">
      <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.panel.stop.confirm')}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="destructive" disabled={actions.busy} onClick={() => { setConfirmingStop(false); void actions.stop(item); }}>{t('bots.stop')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmingStop(false)}>{t('settings.common.actions.cancel')}</Button>
      </div>
    </div> : <div className="flex flex-wrap gap-1.5">
      {item.state === 'needs-you' ? <Button size="sm" disabled={actions.busy} onClick={() => void actions.resume(item)}>{t('bots.resume')}</Button> : null}
      <OpenChatButton item={item} primary={item.state !== 'needs-you'} />
      <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => setConfirmingStop(true)}>{t('bots.stop')}</Button>
    </div>}
  </ItemTile>;
}

function WorkingItem({ item, actions, canTakeOver }: { readonly item: BotWorkItem; readonly actions: ItemActions; readonly canTakeOver: boolean }) {
  const { t } = useI18n();
  const takeOver = <Button size="sm" variant="outline" disabled={actions.busy || !item.worktree} onClick={() => void actions.takeOver(item)}>{t('bots.panel.takeOver')}</Button>;
  return <ItemTile item={item} failure={actions.failureFor(item)}>
    <div className="flex flex-wrap gap-1.5">
      <OpenChatButton item={item} primary={false} />
      {!canTakeOver ? null : item.worktree ? takeOver : <DisabledHint hint={t('bots.panel.takeOver.noWorktree')}>{takeOver}</DisabledHint>}
    </div>
  </ItemTile>;
}

function BotSchedule({ bot }: { readonly bot: BotDefinition }) {
  const { t, locale } = useI18n();
  const { schedule } = bot;
  const days = () => new Intl.ListFormat(locale, { type: 'conjunction' }).format([...schedule.weekdays].sort((a, b) => a - b)
    .map((day) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + day))));
  const sentence = !bot.enabled ? t('bots.panel.schedule.off')
    : schedule.kind === 'manual' ? t('bots.panel.schedule.manual')
      : schedule.kind === 'daily' ? t('bots.panel.schedule.daily', { time: schedule.time })
        : schedule.kind === 'weekly' ? t('bots.panel.schedule.weekly', { days: days(), time: schedule.time })
          : t('bots.panel.schedule.cron');
  return <p className="typography-meta text-foreground">
    {sentence}
    {bot.enabled && schedule.kind === 'cron' ? <> <span className="font-mono" dir="ltr">{schedule.cron}</span></> : null}
    {bot.enabled && schedule.kind !== 'manual' && schedule.timezone ? <span className="text-muted-foreground" dir="ltr"> · {schedule.timezone}</span> : null}
  </p>;
}

function BotPanelHome({ data, actions }: { readonly data: BotPanelData; readonly actions: ItemActions }) {
  const { t } = useI18n();
  const recent = [...data.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const waiting = recent.filter(waitsOnPerson);
  const working = recent.filter((item) => !waitsOnPerson(item) && !hasEnded(item));
  return <>
    <SettingsSection contentClassName="space-y-0">
      {data.bot ? <div className="flex min-w-0 items-center gap-2.5">
        <BotAvatar name={data.bot.name} avatar={data.bot.avatar} size="md" />
        <h2 className="min-w-0 truncate typography-ui-header oc-ui-start-align" dir="auto" title={data.bot.name}>{data.bot.name}</h2>
      </div> : <p className="typography-meta text-muted-foreground">{t('bots.panel.botMissing')}</p>}
    </SettingsSection>
    <SettingsSection title={t('bots.attention')}>
      {waiting.length ? <ul className="space-y-2">{waiting.map((item) => <WaitingItem key={botWorkItemKey(item)} item={item} actions={actions} />)}</ul>
        : <p className="typography-meta text-muted-foreground">{t('bots.panel.needsYou.empty')}</p>}
    </SettingsSection>
    <SettingsSection title={t('bots.panel.working')}>
      {working.length ? <ul className="space-y-2">{working.map((item) => <WorkingItem key={botWorkItemKey(item)} item={item} actions={actions} canTakeOver={data.available.takeOver} />)}</ul>
        : <p className="typography-meta text-muted-foreground">{t('bots.panel.working.empty')}</p>}
    </SettingsSection>
    {data.bot ? <SettingsSection title={t('bots.panel.automations')}><BotSchedule bot={data.bot} /></SettingsSection> : null}
  </>;
}

function ItemArtifacts({ projectId, itemId, readOnly, requirements }: {
  readonly projectId: string; readonly itemId: string; readonly readOnly: boolean; readonly requirements: BotDefinition['artifacts'];
}) {
  const pages = useBotArtifacts({ projectId, itemId }, true, true);
  return <BotArtifactList projectId={projectId} itemId={itemId} readOnly={readOnly} read={pages} requirements={requirements} />;
}

function BotPanelArtifacts({ scope, data, reloads }: { readonly scope: BotPanelScope; readonly data: BotPanelData; readonly reloads: number }) {
  const { t } = useI18n();
  const recent = [...data.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const [pickedKey, setPickedKey] = React.useState<string | null>(null);
  const picked = recent.find((item) => botWorkItemKey(item) === pickedKey) ?? recent[0];
  const target = scope.item ?? picked;
  if (!target) return <p className="typography-meta text-muted-foreground">{t('bots.panel.artifacts.noItems')}</p>;
  const item = recent.find((entry) => botWorkItemKey(entry) === botWorkItemKey(target));
  return <>
    {scope.item ? null : <SettingsSection contentClassName="space-y-0">
      <Select value={botWorkItemKey(target)} onValueChange={(key) => setPickedKey(key)}>
        <SelectTrigger className="max-w-full" aria-label={t('bots.panel.artifacts.item')}><SelectValue>{() => <span className="truncate" dir="auto">{picked?.title}</span>}</SelectValue></SelectTrigger>
        <SelectContent>{recent.map((entry) => <SelectItem key={botWorkItemKey(entry)} value={botWorkItemKey(entry)}><span dir="auto">{entry.title}</span></SelectItem>)}</SelectContent>
      </Select>
    </SettingsSection>}
    <ItemArtifacts key={`${botWorkItemKey(target)}\n${reloads}`} projectId={target.projectId} itemId={target.itemId} readOnly={!item || hasEnded(item)} requirements={data.bot?.artifacts ?? []} />
  </>;
}

export function BotPanelView({ scope }: { readonly scope: BotPanelScope }) {
  const { t } = useI18n();
  const read = useBotPanelData(scope.botId);
  const [tab, setTab] = React.useState<BotPanelTab>('home');
  const actions = useBotItemActions(read.refresh);
  const [reloads, setReloads] = React.useState(0);
  const refresh = () => { read.refresh(); setReloads((count) => count + 1); };
  const labels = { home: t('bots.panel.tab.home'), artifacts: t('bots.panel.tab.artifacts') } satisfies Record<BotPanelTab, string>;
  return <div className="flex h-full min-h-0 flex-col">
    <ContextPanelHeaderToolbar>
      <div className="flex h-10 w-full min-w-0 shrink-0 items-center gap-1 pe-1">
        <SortableTabsStrip className="h-7 min-w-0 flex-1" variant="active-pill" activeId={tab} onSelect={(id) => setTab(TABS.find((entry) => entry === id) ?? 'home')}
          items={TABS.map((id) => ({ id, label: labels[id] }))} />
        <Tooltip>
          <TooltipTrigger asChild><Button size="sm" variant="ghost" disabled={read.busy} onClick={refresh} aria-label={t('bots.refresh')}><Icon name="refresh" /></Button></TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('bots.refresh')}</TooltipContent>
        </Tooltip>
      </div>
    </ContextPanelHeaderToolbar>
    <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-3 pb-6 pt-3" disableHorizontal>
      {read.error ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 typography-meta text-[var(--status-error-text)]">
        <span>{t('bots.panel.loadFailed')}</span><Button size="xs" variant="outline" onClick={read.refresh}>{t('bots.retry')}</Button>
      </div> : null}
      {read.data ? <div>{tab === 'home' ? <BotPanelHome data={read.data} actions={actions} /> : <BotPanelArtifacts scope={scope} data={read.data} reloads={reloads} />}</div>
        : read.error ? null : <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
    </ScrollableOverlay>
  </div>;
}

export function BotPanel() {
  const scope = useBotPanelScope(useEffectiveDirectory());
  return scope ? <BotPanelView key={scope.botId} scope={scope} /> : null;
}
