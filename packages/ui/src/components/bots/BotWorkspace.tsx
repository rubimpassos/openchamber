import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useElementSize } from '@/hooks/useElementSize';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import type { BotDefinition } from '@/lib/bots/config';
import { isTerminalBotItem, type BotItem } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { BotContextPanel, type BotContextTab } from './BotContextPanel';
import { BotStateLabel } from './BotItemList';
import { useBotConversation, useBotItemRead } from './useBotRequest';

const loadChatView = () => import('@/components/views/ChatView').then((module) => module.ChatView);

const SIDE_BY_SIDE_PX = 860;

export function BotWorkspace({ projectId, bot, initial, archived, layout, onBack, onLeave }: {
  readonly projectId: string; readonly bot: BotDefinition | undefined; readonly initial: BotItem; readonly archived: boolean;
  readonly layout: 'page' | 'mobile'; readonly onBack: () => void; readonly onLeave: () => void;
}) {
  const { t } = useI18n();
  const { read, item } = useBotItemRead(projectId, initial, archived);
  const closed = archived || isTerminalBotItem(item);
  const chat = useBotConversation(projectId, item, !closed);
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const wide = layout === 'page' && (size?.width ?? 0) >= SIDE_BY_SIDE_PX;
  const [open, setOpen] = React.useState({ beside: true, covering: false });
  const [tab, setTab] = React.useState<BotContextTab>('work');
  const shown = wide ? open.beside : open.covering;
  const covering = shown && !wide;
  const toggle = () => setOpen((current) => wide ? { ...current, beside: !current.beside } : { ...current, covering: !current.covering });
  const pinned = React.useMemo(
    () => chat.conversation ? { sessionId: chat.conversation.sessionId, directory: chat.conversation.directory } : null,
    [chat.conversation],
  );
  const [chatUnavailable, setChatUnavailable] = React.useState(false);
  const Chat = useOnDemandComponent(pinned !== null && !chatUnavailable, loadChatView, () => setChatUnavailable(true));
  const failed = chat.error || chatUnavailable;
  const retry = () => { setChatUnavailable(false); chat.retry(); };
  const contextToggle = <Button size="sm" variant="ghost" aria-pressed={shown} onClick={toggle} aria-label={wide ? t('bots.context.label') : undefined}
    className={cn('shrink-0', shown && 'oc-selected text-interactive-selection-foreground hover:text-interactive-selection-foreground')}>
    <Icon name="layout-right" />{wide ? null : t('bots.context.label')}
  </Button>;
  return <div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1">
    <section aria-label={item.title} inert={covering} className={cn('flex min-h-0 min-w-0 flex-1 flex-col', covering && 'invisible')}>
      <header className="flex h-10 shrink-0 items-center gap-2 px-2">
        <Tooltip>
          <TooltipTrigger asChild><Button size="sm" variant="ghost" className="shrink-0" onClick={onBack} aria-label={t('bots.back')}><Icon name="arrow-left" /></Button></TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('bots.back')}</TooltipContent>
        </Tooltip>
        {bot ? <BotAvatar name={bot.name} avatar={bot.avatar} described={!wide} /> : null}
        {bot && wide ? <><span className="max-w-1/3 shrink-0 truncate typography-ui-label text-muted-foreground" dir="auto">{bot.name}</span><span aria-hidden="true" className="text-muted-foreground/50">/</span></> : null}
        <h2 className="min-w-0 truncate typography-ui-label oc-ui-start-align" dir="auto" title={item.title}>{item.title}</h2>
        <span aria-hidden="true" className="text-muted-foreground/50">·</span>
        <span className="max-w-2/5 shrink-0 truncate typography-meta"><BotStateLabel state={item.state} /></span>
        <span className="flex-1" />
        {wide ? <Tooltip><TooltipTrigger asChild>{contextToggle}</TooltipTrigger><TooltipContent side="bottom" sideOffset={6}>{t('bots.context.label')}</TooltipContent></Tooltip> : contextToggle}
      </header>
      <div className="relative min-h-0 flex-1">
        {failed ? <div role="alert" className="flex h-full"><ContentState title={t('bots.conversation.failed')} description={t('bots.conversation.failedHint')}
          actions={<Button size="sm" variant="outline" onClick={retry}>{t('bots.retry')}</Button>} /></div>
          : pinned && Chat ? <div className="absolute inset-0"><Chat pinnedSession={pinned} leadDigest readOnly={closed} /></div>
            : pinned || chat.busy ? <ContentLoadingState label={t('bots.conversation.opening')} />
              : <ContentState title={t('bots.conversation.none')} description={t('bots.conversation.noneHint')} />}
      </div>
    </section>
    {shown ? <BotContextPanel projectId={projectId} item={item} detail={read.data} busy={read.busy} failed={read.error} archived={archived}
      tab={tab} onTabChange={setTab} onRefresh={read.refresh} onLeave={onLeave} onClose={covering ? toggle : undefined}
      className={wide ? 'oc-panel-edge relative my-2 me-2 w-85 shrink-0 overflow-hidden rounded-[10px] bg-background' : 'absolute inset-0 z-10 bg-background'} /> : null}
  </div>;
}
