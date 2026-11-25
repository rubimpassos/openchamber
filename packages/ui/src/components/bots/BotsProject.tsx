import React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { fetchBots, runBot, saveBotsConfig } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import type { ProjectEntry } from '@/lib/api/types';
import { isTerminalBotItem, type BotItem } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { useUIStore } from '@/stores/useUIStore';
import { BotEditor } from './BotEditor';
import { BotItemDetail } from './BotItemDetail';
import { BotItemCreate } from './BotItemCreate';
import { BotIdentities } from './BotIdentities';
import { BotWorkspace } from './BotWorkspace';
import { BotPage, BotsOverview } from './BotsOverview';
import { BotsNav, BotsShell, NewDemandButton, type BotsPlace } from './BotsShell';
import { useBotAction, useBotResource, useBotsRefresh } from './useBotRequest';

type Origin = { readonly kind: 'home' } | { readonly kind: 'bot'; readonly botId: string };
type View = Origin
  | { readonly kind: 'editor'; readonly bot: BotDefinition; readonly from: Origin }
  | { readonly kind: 'create'; readonly botId?: string; readonly from: Origin }
  | { readonly kind: 'item'; readonly item: BotItem; readonly archived: boolean; readonly from: Origin };
const HOME: Origin = { kind: 'home' };
const originOf = (view: View): Origin => view.kind === 'home' || view.kind === 'bot' ? view : view.from;
const identityOf = (view: View): string => {
  switch (view.kind) {
    case 'home': return 'home';
    case 'bot': return `bot:${view.botId}`;
    case 'editor': return `editor:${view.bot.id}`;
    case 'create': return 'create';
    case 'item': return `item:${view.item.id}:${view.archived}`;
  }
};

export function BotsProject({ project, onLeave, initialItemId, initialBotId, layout = 'page', picker }: {
  readonly project: ProjectEntry; readonly onLeave: () => void; readonly initialItemId?: string; readonly initialBotId?: string;
  readonly layout?: 'page' | 'mobile'; readonly picker?: React.ReactNode;
}) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBots(project.id), [project.id]);
  const read = useBotResource(load);
  const snapshot = read.data;
  const [tab, setTab] = React.useState('items');
  const [view, setView] = React.useState<View>(HOME);
  const [managingIdentities, setManagingIdentities] = React.useState(false);
  const [identitiesVersion, setIdentitiesVersion] = React.useState(0);
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const identity = `${identityOf(view)}:${tab}`;
  React.useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [identity]);
  const running = useBotAction();
  useBotsRefresh(project.id, read.refresh, layout === 'page' || view.kind === 'home' || view.kind === 'bot');
  React.useEffect(() => {
    if ((!initialItemId && !initialBotId) || !snapshot) return;
    const item = snapshot.items.find((entry) => entry.id === initialItemId);
    const bot = snapshot.config.definitions.find((entry) => entry.id === initialBotId);
    setTargetUnavailable(!item && !bot);
    if (item) setView({ kind: 'item', item, archived: false, from: HOME });
    else if (bot) setView({ kind: 'editor', bot, from: HOME });
    else setView(HOME);
    useUIStore.getState().setBotsPageTarget(null);
  }, [initialItemId, initialBotId, snapshot]);
  const saveBot = async (bot: BotDefinition) => {
    if (!snapshot) return;
    const runtime = getBotsRuntime();
    const existing = snapshot.config.definitions.some((entry) => entry.id === bot.id);
    const definitions = existing ? snapshot.config.definitions.map((entry) => entry.id === bot.id ? bot : entry) : [...snapshot.config.definitions, bot];
    const result = await saveBotsConfig(project.id, { ...snapshot.config, definitions });
    if (!runtime.signal.aborted) read.replace({ ...snapshot, config: result.config });
  };
  const run = (botId: string) => void running.run(async () => { await runBot(project.id, botId); if (running.isActive()) read.refresh(); });
  const bots = snapshot?.config.definitions ?? [];
  const origin = originOf(view);
  const back = () => { setView(origin); read.refresh(); };
  const create = (botId?: string) => setView({ kind: 'create', botId, from: origin });
  const openItem = (item: BotItem, archived: boolean) => setView({ kind: 'item', item, archived, from: origin });
  const workspace = view.kind === 'item' && (view.item.conversation !== undefined || (!view.archived && !isTerminalBotItem(view.item)));
  const place: BotsPlace = view.kind === 'item' ? { kind: 'item', itemId: view.item.id } : origin;
  const shownBot = view.kind === 'bot' ? bots.find((bot) => bot.id === view.botId) : undefined;

  const overview = <BotsOverview projectId={project.id} snapshot={snapshot} tab={tab} onTab={setTab} offersDemand={layout === 'mobile'} running={running}
    status={{ busy: read.busy, failed: read.error, unavailable: targetUnavailable }} onRefresh={read.refresh}
    onConfig={(config) => { if (snapshot) read.replace({ ...snapshot, config }); }}
    onEditBot={(bot) => setView({ kind: 'editor', bot, from: HOME })} onOpenBot={(botId) => setView({ kind: 'bot', botId })}
    onRunBot={run} onCreate={() => create()} onOpenItem={openItem} />;
  const content = (() => {
    switch (view.kind) {
      case 'home': return overview;
      case 'bot': return shownBot ? <BotPage bot={shownBot} items={snapshot?.items.filter((item) => item.botId === shownBot.id) ?? []} running={running}
        onBack={() => setView(HOME)} onCreate={() => create(shownBot.id)} onRun={() => run(shownBot.id)}
        onEdit={() => setView({ kind: 'editor', bot: shownBot, from: view })} onOpenItem={(item) => openItem(item, false)} /> : overview;
      case 'editor': return <>
        <BotEditor key={view.bot.id} projectId={project.id} directory={project.path} initial={view.bot} onSave={saveBot} onClose={() => setView(view.from)} identitiesVersion={identitiesVersion} onManageIdentities={() => setManagingIdentities(true)} />
        <Dialog open={managingIdentities} onOpenChange={(open) => { setManagingIdentities(open); if (!open) setIdentitiesVersion((version) => version + 1); }}>
          <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto"><DialogTitle>{t('bots.identities')}</DialogTitle>{managingIdentities ? <BotIdentities projectId={project.id} /> : null}</DialogContent>
        </Dialog>
      </>;
      case 'create': return <BotItemCreate projectId={project.id} bots={bots} botId={view.botId} onClose={() => setView(view.from)}
        onCreated={(item) => { setView({ kind: 'item', item, archived: false, from: view.from }); read.refresh(); }} />;
      case 'item': return workspace
        ? <BotWorkspace key={view.item.id} projectId={project.id} bot={bots.find((bot) => bot.id === view.item.botId)} initial={view.item} archived={view.archived} layout={layout} onBack={back} onLeave={onLeave} />
        : <BotItemDetail key={view.item.id} projectId={project.id} initial={view.item} archived={view.archived} onBack={back} onLeave={onLeave} />;
    }
  })();

  return <BotsShell layout={layout} picker={picker} full={workspace} scrollRef={scrollRef}
    nav={<BotsNav bots={bots} items={snapshot?.items ?? []} place={place} onNavigate={(next) => {
      if (next.kind === 'item') setView({ kind: 'item', item: next.item, archived: false, from: origin.kind === 'bot' && origin.botId === next.item.botId ? origin : HOME });
      else setView(next);
    }} />}
    footer={<NewDemandButton disabled={!bots.length} onClick={() => create(origin.kind === 'bot' ? origin.botId : undefined)} />}>
    {content}
  </BotsShell>;
}
