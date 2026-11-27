import React from 'react';
import { BotAvatar } from '@/components/bots/BotAvatar';
import { BotAttentionMark, BotChatState, BotStatusLine } from '@/components/bots/BotsSidebarSection';
import {
  botExpansionKey, botItemNeedsYou, botItemWorking, botStatusCounts, botTitleClass, useBotChatRows, useBotSidebarActions,
  type BotChatTarget, type BotSidebarEntry, type BotsSidebarModel,
} from '@/hooks/useBotsSidebar';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { HeaderIconButton, MobileCaption } from './MobileSectionRows';
import type { MobileTreeGeometry } from './mobileSidebarGeometry';
import { MOBILE_ACTIVE_ROW_CLASS, MOBILE_ONE_LINE_ROW_CLASS } from './mobileRowParts';

const TILE_CLASS = 'relative flex w-full items-center rounded-lg bg-background transition-colors';
const TITLE_CLASS = 'block min-w-0 flex-1 truncate oc-ui-start-align typography-ui-label';
const LINK_CLASS = 'flex min-h-9 items-center py-1 text-start typography-micro text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';
const TOUCH: React.CSSProperties = { touchAction: 'manipulation' };

type Actions = ReturnType<typeof useBotSidebarActions>;

function ChatRow({ target, title, titleClass, indent, lead, end, onOpen }: {
  readonly target: BotChatTarget | null; readonly title: string; readonly titleClass: (selected: boolean) => string;
  readonly indent: number; readonly lead?: React.ReactNode; readonly end?: React.ReactNode; readonly onOpen: () => void;
}) {
  const selected = useSessionUIStore((state) => target !== null && state.currentSessionId === target.sessionId);
  return <div data-active-session={selected || undefined} className={cn(TILE_CLASS, selected && MOBILE_ACTIVE_ROW_CLASS)}>
    <button type="button" data-bot-chat={target?.sessionId} className={MOBILE_ONE_LINE_ROW_CLASS} style={{ ...TOUCH, paddingInlineStart: indent }} onClick={onOpen}>
      {lead ? <span className="-me-1 inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{lead}</span> : null}
      <span dir="auto" className={cn(TITLE_CLASS, titleClass(selected))}>{title}</span>
      {end}
    </button>
  </div>;
}

function BotChats({ entry, chats, geometry, actions }: {
  readonly entry: BotSidebarEntry; readonly chats: NonNullable<BotSidebarEntry['chats']>;
  readonly geometry: MobileTreeGeometry; readonly actions: Actions;
}) {
  const { t } = useI18n();
  const list = useBotChatRows(chats.items);
  const main: BotChatTarget | null = chats.main ? { sessionId: chats.main.sessionId, directory: chats.main.directory } : null;
  return <>
    {chats.available.mainChat || main ? <ChatRow
      target={main}
      title={t('bots.sidebar.mainChat')}
      titleClass={(selected) => botTitleClass({ selected, needsYou: false, working: false })}
      indent={geometry.slotLeft(1)}
      lead={<Icon name="chat-4" className="size-3.5" />}
      end={actions.openingMainOf === entry.bot.id ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
      onOpen={() => { void actions.openMainChat(entry.bot.id, main !== null); }}
    /> : null}
    {list.rows.map((row) => <ChatRow
      key={row.item.itemId}
      target={row.target}
      title={row.item.title}
      titleClass={(selected) => botTitleClass({ selected, needsYou: !row.item.takenOver && botItemNeedsYou(row.item), working: !row.item.takenOver && botItemWorking(row.item) })}
      indent={geometry.textLeft(1)}
      end={<BotChatState row={row} tooltip={false} />}
      onOpen={() => actions.openChat(row.target)}
    />)}
    {list.more || list.fewer || list.hasEnded ? <div className="flex w-full items-center gap-4 pe-3" style={{ paddingInlineStart: geometry.textLeft(1) }}>
      {list.more ? <button type="button" className={LINK_CLASS} style={TOUCH} onClick={list.showMore}>{t('sessions.sidebar.group.showMore')}</button> : null}
      {list.fewer ? <button type="button" className={LINK_CLASS} style={TOUCH} onClick={list.showFewer}>{t('sessions.sidebar.group.showFewer')}</button> : null}
      {list.hasEnded ? <button type="button" className={LINK_CLASS} style={TOUCH} aria-pressed={list.showEnded} onClick={list.toggleEnded}>{t(list.showEnded ? 'bots.sidebar.hideEnded' : 'bots.sidebar.showEnded')}</button> : null}
    </div> : null}
  </>;
}

function FailedRow({ label, indent, onRetry }: { readonly label: string; readonly indent: number; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return <div role="status" className="flex min-h-9 flex-wrap items-center gap-2 py-1 pe-3 typography-micro text-muted-foreground" style={{ paddingInlineStart: indent }}>
    <span>{label}</span>
    <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={onRetry}>{t('sessions.sidebar.group.empty.retry')}</Button>
  </div>;
}

function BotRow({ entry, expanded, onToggle, geometry, actions, onRetry }: {
  readonly entry: BotSidebarEntry; readonly expanded: boolean; readonly onToggle: () => void;
  readonly geometry: MobileTreeGeometry; readonly actions: Actions; readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const { bot, chats } = entry;
  const counts = React.useMemo(() => botStatusCounts(chats?.items ?? []), [chats]);
  return <>
    <div className={TILE_CLASS}>
      <button type="button" data-bot-row={bot.id} aria-expanded={expanded} className={MOBILE_ONE_LINE_ROW_CLASS} style={{ ...TOUCH, paddingInlineStart: geometry.slotLeft(0) }} onClick={onToggle}>
        <span className="-me-1 inline-flex size-3.5 shrink-0 items-center justify-center"><FileTreeChevron expanded={expanded} /></span>
        <BotAvatar name={bot.name} avatar={bot.avatar} />
        <span dir="auto" className={cn(TITLE_CLASS, botTitleClass({ needsYou: counts.needsYou > 0, working: counts.working > 0 }))}>{bot.name}</span>
        {counts.needsYou > 0 ? <BotAttentionMark tooltip={false} /> : null}
        <BotStatusLine counts={counts} />
      </button>
    </div>
    {expanded ? chats
      ? <BotChats entry={entry} chats={chats} geometry={geometry} actions={actions} />
      : <FailedRow label={t('bots.sidebar.chatsFailed')} indent={geometry.textLeft(1)} onRetry={onRetry} /> : null}
  </>;
}

export function MobileBotsSection({ model, collapsed, onToggle, expandedKeys, onToggleExpanded, geometry, onNavigate }: {
  readonly model: BotsSidebarModel;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly expandedKeys: ReadonlySet<string>;
  readonly onToggleExpanded: (key: string) => void;
  readonly geometry: MobileTreeGeometry;
  readonly onNavigate: () => void;
}) {
  const { t } = useI18n();
  const actions = useBotSidebarActions(model.refresh, onNavigate);
  return <div data-bots-sidebar-section="">
    <div className="flex min-h-10 w-full items-center">
      <MobileCaption label={t('bots.sidebar.title')} collapsed={collapsed} onToggle={onToggle} />
      <HeaderIconButton icon="add" label={t('bots.sidebar.newBot')} onClick={actions.newBot} />
    </div>
    {collapsed ? null : <>
      {model.failed ? <FailedRow label={t('bots.sidebar.loadFailed')} indent={geometry.textLeft(0)} onRetry={model.refresh} /> : null}
      {model.bots.map((entry) => {
        const key = botExpansionKey(entry.bot.id);
        return <BotRow key={entry.bot.id} entry={entry} expanded={expandedKeys.has(key)} onToggle={() => onToggleExpanded(key)} geometry={geometry} actions={actions} onRetry={model.refresh} />;
      })}
    </>}
  </div>;
}
