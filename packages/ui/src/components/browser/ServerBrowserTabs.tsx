import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ServerBrowserTab } from '@/lib/browser/serverBrowser/types';

/** This chat's page tabs, from `/browser/state`. Hidden entirely at one tab. */
export const ServerBrowserTabs: React.FC<{
  tabs: readonly ServerBrowserTab[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}> = ({ tabs, onSelect, onClose, onNew }) => {
  const { t } = useI18n();
  if (tabs.length <= 1) return null;

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-[var(--surface-background)] px-2 py-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={cn(
            'group flex min-w-0 max-w-[160px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1',
            'typography-micro text-muted-foreground hover:bg-[var(--interactive-hover)]',
            tab.active && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
          )}
        >
          {tab.isLoading ? (
            <Icon name="loader-4" className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 truncate">{tab.title || tab.url || t('contextPanel.browser.newTab')}</span>
          <span
            role="button"
            tabIndex={-1}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(tab.id); }}
            aria-label={t('contextPanel.browser.server.tabClose')}
            className="ml-auto shrink-0 rounded-full p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--interactive-active)]"
          >
            <Icon name="close" className="size-3" aria-hidden="true" />
          </span>
        </button>
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-6 shrink-0 rounded-full px-0 text-muted-foreground hover:text-foreground"
            onClick={onNew}
            aria-label={t('contextPanel.browser.newTab')}
          >
            <Icon name="add" className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t('contextPanel.browser.newTab')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
