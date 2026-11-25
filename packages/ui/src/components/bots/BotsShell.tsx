import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { BotDefinition } from '@/lib/bots/config';
import type { BotItem } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BotAvatar } from './BotAvatar';
import { BotStateMark } from './BotItemList';

export type BotsPlace = { readonly kind: 'home' } | { readonly kind: 'bot'; readonly botId: string } | { readonly kind: 'item'; readonly itemId: string };

const rowClass = (current: boolean) => cn(
  'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label focus-visible:outline-none',
  current ? 'bg-interactive-selection text-foreground'
    : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:bg-interactive-hover/50 focus-visible:text-foreground',
);

export function BotsNav({ bots, items, place, onNavigate }: {
  readonly bots: readonly BotDefinition[]; readonly items: readonly BotItem[];
  readonly place: BotsPlace; readonly onNavigate: (place: { readonly kind: 'home' } | { readonly kind: 'bot'; readonly botId: string } | { readonly kind: 'item'; readonly item: BotItem }) => void;
}) {
  const { t } = useI18n();
  return <div className="space-y-0.5">
    <button type="button" className={rowClass(place.kind === 'home')} aria-current={place.kind === 'home' ? 'page' : undefined} onClick={() => onNavigate({ kind: 'home' })}>
      <Icon name="home" className="size-4 shrink-0" /><span className="truncate">{t('bots.nav.overview')}</span>
    </button>
    {bots.length ? <div className="px-2 pb-1 pt-4 typography-ui-label text-muted-foreground">{t('bots.title')}</div> : null}
    {bots.map((bot) => {
      const current = place.kind === 'bot' && place.botId === bot.id;
      const work = items.filter((item) => item.botId === bot.id);
      return <React.Fragment key={bot.id}>
        <button type="button" className={rowClass(current)} aria-current={current ? 'page' : undefined} title={bot.name} onClick={() => onNavigate({ kind: 'bot', botId: bot.id })}>
          <BotAvatar name={bot.name} avatar={bot.avatar} /><span className="truncate oc-ui-start-align" dir="auto">{bot.name}</span>
        </button>
        {work.length ? <ul className="space-y-0.5">{work.map((item) => {
          const shown = place.kind === 'item' && place.itemId === item.id;
          return <li key={item.id}>
            <button type="button" className={cn(rowClass(shown), 'ps-4')} aria-current={shown ? 'page' : undefined} title={item.title} onClick={() => onNavigate({ kind: 'item', item })}>
              <span className="flex size-5 shrink-0 items-center justify-center"><BotStateMark state={item.state} /></span>
              <span className="truncate oc-ui-start-align" dir="auto">{item.title}</span>
            </button>
          </li>;
        })}</ul> : null}
      </React.Fragment>;
    })}
  </div>;
}

export function BotsShell({ layout, picker, nav, footer, full = false, scrollRef, children }: {
  readonly layout: 'page' | 'mobile'; readonly picker?: React.ReactNode; readonly nav?: React.ReactNode; readonly footer?: React.ReactNode;
  readonly full?: boolean; readonly scrollRef?: React.Ref<HTMLDivElement>; readonly children: React.ReactNode;
}) {
  const { t } = useI18n();
  if (layout === 'mobile') {
    return full ? <div key="full" className="flex h-full min-h-0 flex-col">{children}</div>
      : <div key="pages" ref={scrollRef} className="h-full min-h-0 space-y-4 overflow-y-auto px-4 py-4">{picker}{children}</div>;
  }
  return <div className="absolute inset-0 z-10 flex bg-background">
    <nav aria-label={t('bots.title')} className="flex w-60 shrink-0 flex-col border-e border-border/50">
      {picker ? <div className="p-2 pb-0">{picker}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{nav}</div>
      {footer ? <div className="p-2">{footer}</div> : null}
    </nav>
    <div className="flex min-w-0 flex-1 flex-col">
      {full ? children : <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4"><div className="mx-auto w-full max-w-3xl">{children}</div></div>}
    </div>
  </div>;
}

export function NewDemandButton({ onClick, disabled, variant = 'outline' }: {
  readonly onClick: () => void; readonly disabled?: boolean; readonly variant?: 'outline' | 'default';
}) {
  const { t } = useI18n();
  return <Button size="sm" variant={variant} disabled={disabled} onClick={onClick}><Icon name="add" />{t('bots.newItem')}</Button>;
}
