import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Same beat as the background action beside it. */
const TOOLTIP_DELAY_MS = 750;

/**
 * "Retry now" for a turn waiting on an automatic retry. Shared by the status
 * chip above the composer and the scroll-to-bottom pill that stands in for it.
 */
export const RetryNowButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => {
    const { t } = useI18n();
    const label = t('chat.statusRow.retryNow.action');

    return (
        <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onClick();
                    }}
                    aria-label={label}
                    className={cn(
                        'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors',
                        'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        className,
                    )}
                >
                    <Icon name="refresh" className="h-4 w-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
    );
};
