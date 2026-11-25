import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { NumberInput } from '@/components/ui/number-input';
import { saveBotsConfig, type BotsSnapshot } from '@/lib/botsApi';
import { botDefinitionSchema, newBotDraft, type BotDefinition } from '@/lib/bots/config';
import type { BotItem } from '@/lib/bots/items';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { BotArchive } from './BotArchive';
import { BotAvatar } from './BotAvatar';
import { BotIdentities } from './BotIdentities';
import { BotItemList } from './BotItemList';
import { BotPolicy } from './BotPolicy';
import { NewDemandButton } from './BotsShell';
import { useBotAction } from './useBotRequest';

const presetLabels = new Map<string, I18nKey>([
  ['jira-bugs', 'bots.preset.jira-bugs'], ['security-infra', 'bots.preset.security-infra'],
  ['dependencies', 'bots.preset.dependencies'], ['performance', 'bots.preset.performance'], ['repository-rules', 'bots.preset.repository-rules'],
]);

type Props = {
  readonly projectId: string; readonly snapshot: BotsSnapshot | null;
  readonly status: { readonly busy: boolean; readonly failed: boolean; readonly unavailable: boolean };
  readonly tab: string; readonly onTab: (tab: string) => void;
  readonly offersDemand: boolean; readonly running: ReturnType<typeof useBotAction>;
  readonly onRefresh: () => void; readonly onConfig: (config: BotsSnapshot['config']) => void;
  readonly onEditBot: (bot: BotDefinition) => void; readonly onOpenBot: (botId: string) => void;
  readonly onRunBot: (botId: string) => void; readonly onCreate: () => void;
  readonly onOpenItem: (item: BotItem, archived: boolean) => void;
};

export function BotsOverview({ projectId, snapshot, status, tab, onTab, offersDemand, running, onRefresh, onConfig, onEditBot, onOpenBot, onRunBot, onCreate, onOpenItem }: Props) {
  const { t } = useI18n();
  const [configure, setConfigure] = React.useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const attention = snapshot?.items.filter((item) => item.state === 'needs-you' || item.state === 'waiting-answer') ?? [];
  return <div className="min-w-0 @container space-y-4">
    <div className="flex min-w-0 items-center gap-2">
      <Button size="sm" onClick={() => onEditBot(newBotDraft())} disabled={!snapshot}>{t('bots.newBot')}</Button>
      {offersDemand ? <NewDemandButton disabled={!snapshot?.config.definitions.length} onClick={onCreate} /> : null}
      <Button size="sm" variant="ghost" className="ms-auto" aria-pressed={configure} onClick={() => setConfigure((value) => !value)} disabled={!snapshot}><Icon name="settings-3" className="size-4" /><span className="sr-only">{t('bots.configure')}</span></Button>
      <Button size="sm" variant="ghost" disabled={status.busy} onClick={onRefresh} aria-label={t('bots.refresh')}><Icon name="refresh" className="size-4" /></Button>
    </div>
    <div className="min-h-5 typography-meta" role={status.failed || running.error ? 'alert' : 'status'}>
      {status.failed || running.error ? <p className="text-[var(--status-error-text)]">{running.error ?? t('bots.error')}</p> : snapshot ? t('bots.tokensToday', { count: snapshot.items.reduce((sum, item) => sum + (item.tokens.byDay[today] ?? 0), 0) }) : t('common.loading')}
    </div>
    {status.unavailable ? <p role="alert" className="typography-meta text-[var(--status-warning-text)]">{t('common.unavailable')}</p> : null}
    {configure && snapshot ? <BotsProjectConfig projectId={projectId} snapshot={snapshot} onSaved={onConfig} /> : null}
    <SortableTabsStrip className="h-7" variant="active-pill" activeId={tab} onSelect={onTab} items={[
      { id: 'items', label: t('bots.items') }, { id: 'audit', label: t('bots.audit') }, { id: 'rules', label: t('bots.rules') },
      { id: 'identities', label: t('bots.identities') }, { id: 'archive', label: t('bots.archive') },
    ]} />
    {tab === 'items' && snapshot ? <>
      {attention.length ? <SettingsSection title={t('bots.attention')} divider={false}><BotItemList items={attention} onOpen={(item) => onOpenItem(item, false)} /></SettingsSection> : null}
      <SettingsSection title={t('bots.title')} divider={false} contentClassName="space-y-2">
        {snapshot.config.definitions.map((bot) => <article key={bot.id} className="oc-tile flex min-w-0 items-center gap-3 rounded-lg p-3">
          <BotAvatar name={bot.name} avatar={bot.avatar} size="md" />
          <div className="min-w-0 flex-1">
            <Button variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-foreground" title={bot.name} onClick={() => onOpenBot(bot.id)}>
              <span className="truncate oc-ui-start-align" dir="auto">{bot.name}</span>
            </Button>
            <p className="truncate typography-meta text-muted-foreground" dir="auto" title={bot.mission}>{bot.mission}</p>
          </div>
          <Button size="sm" variant="outline" disabled={running.busy || !bot.enabled} onClick={() => onRunBot(bot.id)}>{t('bots.run')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onEditBot(bot)}>{t('bots.edit')}</Button>
        </article>)}
        {snapshot.config.definitions.length === 0 ? <p className="typography-meta text-muted-foreground">{t('bots.empty')}</p> : null}
        {snapshot.presets.length ? <div className="flex flex-wrap gap-2 pt-2">{snapshot.presets.map((preset) => {
          const key = presetLabels.get(preset.id);
          const name = key ? t(key) : preset.name;
          return <Button key={preset.id} size="sm" variant="chip" onClick={() => onEditBot(botDefinitionSchema.parse({ ...preset, id: crypto.randomUUID(), name }))}>{name}</Button>;
        })}</div> : null}
      </SettingsSection>
      <SettingsSection title={t('bots.items')}><BotItemList items={snapshot.items.filter((item) => !attention.includes(item))} onOpen={(item) => onOpenItem(item, false)} /></SettingsSection>
    </> : null}
    {tab === 'audit' && snapshot ? <BotItemList items={snapshot.items} onOpen={(item) => onOpenItem(item, false)} audit /> : null}
    {tab === 'rules' ? <BotPolicy projectId={projectId} /> : null}
    {tab === 'identities' ? <BotIdentities projectId={projectId} /> : null}
    {tab === 'archive' ? <BotArchive projectId={projectId} onOpen={(item) => onOpenItem(item, true)} /> : null}
  </div>;
}

export function BotPage({ bot, items, running, onBack, onCreate, onRun, onEdit, onOpenItem }: {
  readonly bot: BotDefinition; readonly items: readonly BotItem[]; readonly running: ReturnType<typeof useBotAction>;
  readonly onBack: () => void; readonly onCreate: () => void; readonly onRun: () => void; readonly onEdit: () => void;
  readonly onOpenItem: (item: BotItem) => void;
}) {
  const { t } = useI18n();
  return <div className="min-w-0 @container space-y-4">
    <div><Button size="sm" variant="ghost" onClick={onBack}>{t('bots.back')}</Button></div>
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <BotAvatar name={bot.name} avatar={bot.avatar} size="lg" />
      <div className="min-w-0 flex-1 basis-48 space-y-1">
        <h2 className="break-words typography-ui-header" dir="auto">{bot.name}</h2>
        <p className="whitespace-pre-wrap break-words typography-meta text-muted-foreground" dir="auto">{bot.mission}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NewDemandButton variant="default" disabled={!bot.enabled} onClick={onCreate} />
        <Button size="sm" variant="outline" disabled={running.busy || !bot.enabled} onClick={onRun}>{t('bots.run')}</Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>{t('bots.edit')}</Button>
      </div>
    </div>
    <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{running.error}</div>
    <SettingsSection title={t('bots.botPage.work')} divider={false}>
      {items.length ? <BotItemList items={items} onOpen={onOpenItem} /> : <p className="py-4 typography-meta text-muted-foreground" dir="auto">{t('bots.botPage.empty', { name: bot.name })}</p>}
    </SettingsSection>
  </div>;
}

function BotsProjectConfig({ projectId, snapshot, onSaved }: {
  readonly projectId: string; readonly snapshot: BotsSnapshot; readonly onSaved: (config: BotsSnapshot['config']) => void;
}) {
  const { t } = useI18n();
  const [concurrency, setConcurrency] = React.useState(snapshot.config.concurrency);
  const [retentionDays, setRetention] = React.useState(snapshot.config.retentionDays);
  const action = useBotAction();
  return <SettingsSection title={t('bots.configure')} divider={false} contentClassName="space-y-3">
    <SettingsTwoColumn>
      <SettingsStackedField label={t('bots.concurrency')}><NumberInput aria-label={t('bots.concurrency')} value={concurrency} min={1} onValueChange={setConcurrency} /></SettingsStackedField>
      <SettingsStackedField label={t('bots.retention')}><NumberInput aria-label={t('bots.retention')} value={retentionDays} min={0} onValueChange={setRetention} /></SettingsStackedField>
    </SettingsTwoColumn>
    <Button size="sm" disabled={action.busy} onClick={() => void action.run(async () => { const result = await saveBotsConfig(projectId, { ...snapshot.config, concurrency, retentionDays }); if (action.isActive()) onSaved(result.config); })}>{t('settings.common.actions.saveChanges')}</Button>
    <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{action.error}</div>
  </SettingsSection>;
}
