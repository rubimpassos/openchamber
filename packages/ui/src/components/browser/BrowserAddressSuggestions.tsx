import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { browserUrlLabel } from '@/lib/browser/url';
import type { BrowserHistoryEntry } from '@/lib/browser/history';

export const BrowserAddressSuggestions: React.FC<{
  entries: readonly BrowserHistoryEntry[];
  activeIndex: number;
  onSelect: (url: string) => void;
  onForget: (url: string) => void;
  onHighlight: (index: number) => void;
}> = ({ entries, activeIndex, onSelect, onForget, onHighlight }) => {
  const { t } = useI18n();
  if (entries.length === 0) return null;

  return (
    <div
      className="oc-glass-popover oc-glass-floating absolute inset-x-0 top-full z-50 mt-1 max-h-[min(20rem,45dvh)] overflow-y-auto rounded-xl p-1"
      role="listbox"
      aria-label={t('contextPanel.browser.history.label')}
    >
      {entries.map((entry, index) => (
        <div
          key={entry.url}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            'group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 pointer-coarse:min-h-11',
            index === activeIndex ? 'bg-interactive-hover' : 'hover:bg-interactive-hover',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(entry.url)}
          onPointerEnter={() => onHighlight(index)}
        >
          <Icon name="global" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate typography-micro text-foreground">
              {entry.title || browserUrlLabel(entry.url)}
            </div>
            <div className="truncate typography-micro text-muted-foreground">{entry.url}</div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground opacity-0 transition-opacity',
                  'hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
                )}
                aria-label={t('contextPanel.browser.history.forget')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onForget(entry.url);
                }}
              >
                <Icon name="close" className="size-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('contextPanel.browser.history.forget')}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
};
