import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { RowMarkTooltip } from '@/components/session/sidebar/sessions/RowMarkTooltip';
import { sessionTreeRowPaddingLeft, sessionTreeTextInset } from '@/components/session/sidebar/sessions/sessionTreeGeometry';
import { SessionSidebarActivityHeader } from '@/components/session/sidebar/sessionSidebarHeaderPresentation';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { BotAvatar } from './BotAvatar';
import { BotStateLabel } from './BotItemList';
import {
  botExpansionKey, botItemNeedsYou, botItemWorking, botStatusCounts, botTitleClass, useBotChatRows, useBotSidebarActions, useBotStatusLine,
  type BotChatRow, type BotChatTarget, type BotSidebarEntry, type BotsSidebarModel, type BotStatusCounts,
} from '@/hooks/useBotsSidebar';

const ROW_CLASS = 'my-px flex w-full items-center gap-1.5 rounded-md py-[5px] pe-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const REST_ROW_CLASS = 'hover:bg-interactive-hover/60';
const SELECTED_ROW_CLASS = 'oc-selected text-interactive-selection-foreground';
const LINK_CLASS = 'inline-flex items-center gap-1.5 rounded-md py-0.5 typography-micro text-muted-foreground leading-tight hover:text-foreground hover:underline';

export function BotAttentionMark({ tooltip = true }: { readonly tooltip?: boolean }) {
  const { t } = useI18n();
  const label = t('bots.sidebar.needsYou');
  const mark = <span role="img" aria-label={label} className="inline-flex shrink-0 items-center text-status-warning"><Icon name="question" className="size-3" /></span>;
  return tooltip ? <RowMarkTooltip label={label}>{mark}</RowMarkTooltip> : mark;
}

export function BotChatState({ row, tooltip = true }: { readonly row: BotChatRow; readonly tooltip?: boolean }) {
  const { t } = useI18n();
  if (row.item.takenOver) return <span className="shrink-0 typography-micro text-muted-foreground">{t('bots.sidebar.takenOver')}</span>;
  return <>
    {botItemNeedsYou(row.item) ? <BotAttentionMark tooltip={tooltip} /> : null}
    <span className="shrink-0 typography-micro"><BotStateLabel state={row.item.state} /></span>
  </>;
}

export function BotStatusLine({ counts }: { readonly counts: BotStatusCounts }) {
  const line = useBotStatusLine(counts);
  return line ? <span dir="auto" title={line} className="min-w-0 max-w-[60%] truncate typography-micro text-muted-foreground">{line}</span> : null;
}

function ChatRow({ target, title, titleClass, lead, end, onOpen }: {
  readonly target: BotChatTarget | null; readonly title: string; readonly titleClass: (selected: boolean) => string;
  readonly lead?: React.ReactNode; readonly end?: React.ReactNode; readonly onOpen: () => void;
}) {
  const selected = useSessionUIStore((state) => target !== null && state.currentSessionId === target.sessionId);
  return <button
    type="button"
    data-bot-chat={target?.sessionId}
    aria-current={selected ? 'page' : undefined}
    onClick={onOpen}
    style={{ paddingInlineStart: lead ? sessionTreeRowPaddingLeft(1) : sessionTreeTextInset(1) }}
    className={cn(ROW_CLASS, selected ? SELECTED_ROW_CLASS : REST_ROW_CLASS)}
  >
    {lead ? <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{lead}</span> : null}
    <span dir="auto" className={cn('oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label', titleClass(selected))}>{title}</span>
    {end}
  </button>;
}

function BotChats({ entry, chats, actions }: {
  readonly entry: BotSidebarEntry; readonly chats: NonNullable<BotSidebarEntry['chats']>;
  readonly actions: ReturnType<typeof useBotSidebarActions>;
}) {
  const { t } = useI18n();
  const list = useBotChatRows(chats.items);
  const main: BotChatTarget | null = chats.main ? { sessionId: chats.main.sessionId, directory: chats.main.directory } : null;
  const controls = [
    list.more ? <button key="more" type="button" className={LINK_CLASS} onClick={list.showMore}>{t('sessions.sidebar.group.showMore')}</button> : null,
    list.fewer ? <button key="fewer" type="button" className={LINK_CLASS} onClick={list.showFewer}>{t('sessions.sidebar.group.showFewer')}</button> : null,
    list.hasEnded ? <button key="ended" type="button" className={LINK_CLASS} aria-pressed={list.showEnded} onClick={list.toggleEnded}>{t(list.showEnded ? 'bots.sidebar.hideEnded' : 'bots.sidebar.showEnded')}</button> : null,
  ].filter((control) => control !== null);
  return <>
    {chats.available.mainChat || main ? <ChatRow
      target={main}
      title={t('bots.sidebar.mainChat')}
      titleClass={(selected) => botTitleClass({ selected, needsYou: false, working: false })}
      lead={<Icon name="chat-4" className="size-3.5" />}
      end={actions.openingMainOf === entry.bot.id ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
      onOpen={() => { void actions.openMainChat(entry.bot.id, main !== null); }}
    /> : null}
    {list.rows.map((row) => <ChatRow
      key={row.item.itemId}
      target={row.target}
      title={row.item.title}
      titleClass={(selected) => botTitleClass({ selected, needsYou: !row.item.takenOver && botItemNeedsYou(row.item), working: !row.item.takenOver && botItemWorking(row.item) })}
      end={<BotChatState row={row} />}
      onOpen={() => actions.openChat(row.target)}
    />)}
    {controls.length > 0 ? <div className="mt-0.5 flex items-center gap-1.5 pe-1.5" style={{ paddingInlineStart: sessionTreeTextInset(1) }}>
      {controls.map((control, index) => <React.Fragment key={control.key}>
        {index > 0 ? <span aria-hidden="true" className="typography-micro text-muted-foreground/50">·</span> : null}
        {control}
      </React.Fragment>)}
    </div> : null}
  </>;
}

function FailedRow({ label, depth, onRetry }: { readonly label: string; readonly depth: number; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return <div role="status" className="py-1 text-start typography-micro text-muted-foreground" style={{ paddingInlineStart: sessionTreeTextInset(depth) }}>
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {label}
      <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={onRetry}>{t('sessions.sidebar.group.empty.retry')}</Button>
    </span>
  </div>;
}

function BotRow({ entry, expanded, onToggle, actions, onRetry }: {
  readonly entry: BotSidebarEntry; readonly expanded: boolean; readonly onToggle: () => void;
  readonly actions: ReturnType<typeof useBotSidebarActions>; readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const { bot, chats } = entry;
  const counts = React.useMemo(() => botStatusCounts(chats?.items ?? []), [chats]);
  return <>
    <button type="button" data-bot-row={bot.id} aria-expanded={expanded} onClick={onToggle} style={{ paddingInlineStart: sessionTreeRowPaddingLeft(0) }} className={cn(ROW_CLASS, REST_ROW_CLASS)}>
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center"><FileTreeChevron expanded={expanded} /></span>
      <BotAvatar name={bot.name} avatar={bot.avatar} className="size-4" />
      <span dir="auto" className={cn('oc-ui-start-align min-w-0 flex-1 truncate typography-ui-label', botTitleClass({ needsYou: counts.needsYou > 0, working: counts.working > 0 }))}>{bot.name}</span>
      {counts.needsYou > 0 ? <BotAttentionMark /> : null}
      <BotStatusLine counts={counts} />
    </button>
    {expanded ? chats
      ? <BotChats entry={entry} chats={chats} actions={actions} />
      : <FailedRow label={t('bots.sidebar.chatsFailed')} depth={1} onRetry={onRetry} /> : null}
  </>;
}

export function BotsSidebarSection({ model, collapsed, onToggle, expandedKeys, onToggleExpanded, alwaysShowActions, onNavigate, renderHeader }: {
  readonly model: BotsSidebarModel;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly expandedKeys: ReadonlySet<string>;
  readonly onToggleExpanded: (key: string) => void;
  readonly alwaysShowActions: boolean;
  readonly onNavigate?: () => void;
  readonly renderHeader?: (header: React.ReactNode) => React.ReactNode;
}) {
  const { t } = useI18n();
  const actions = useBotSidebarActions(model.refresh, onNavigate);
  const header = <SessionSidebarActivityHeader
    activityKey="bots"
    collapsed={collapsed}
    alwaysShowActions={alwaysShowActions}
    onToggle={onToggle}
    addLabel={t('bots.sidebar.newBot')}
    onAdd={actions.newBot}
  />;
  return <div data-bots-sidebar-section="">
    {renderHeader ? renderHeader(header) : header}
    {collapsed ? null : <>
      {model.failed ? <FailedRow label={t('bots.sidebar.loadFailed')} depth={0} onRetry={model.refresh} /> : null}
      {model.bots.map((entry) => {
        const key = botExpansionKey(entry.bot.id);
        return <BotRow key={entry.bot.id} entry={entry} expanded={expandedKeys.has(key)} onToggle={() => onToggleExpanded(key)} actions={actions} onRetry={model.refresh} />;
      })}
    </>}
  </div>;
}
