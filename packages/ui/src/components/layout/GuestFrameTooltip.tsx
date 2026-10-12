import React from 'react';
import { createPortal } from 'react-dom';
import type { GuestFrameTooltipState } from '@/lib/guests/tooltip';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The tooltip an extension frame asked for (`host.showTooltip`), drawn with
 * the app's own tooltip over a stand-in for the guest's element.
 */
export const GuestFrameTooltip: React.FC<{ tooltip: GuestFrameTooltipState }> = ({ tooltip }) => createPortal(
  <Tooltip open>
    <TooltipTrigger asChild>
      <span
        aria-hidden="true"
        className="pointer-events-none fixed"
        style={{ left: tooltip.rect.left, top: tooltip.rect.top, width: tooltip.rect.width, height: tooltip.rect.height }}
      />
    </TooltipTrigger>
    <TooltipContent
      side={tooltip.side ?? 'top'}
      sideOffset={6}
      className="max-w-[min(360px,calc(100vw-24px))] whitespace-normal break-words text-start"
    >
      <span className="line-clamp-16 whitespace-pre-line">{tooltip.text}</span>
    </TooltipContent>
  </Tooltip>,
  document.body,
);
