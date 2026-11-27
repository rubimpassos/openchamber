import React from 'react';
import { declaredSurfaceWidth } from '@/lib/surfaces/registry';
import type { ContextPanelMode } from '@/lib/surfaces/modes';
import { CONTEXT_ZONE_DEFAULT_WIDTH, ownPanelWidth } from '@/lib/workspace/zones';
import { useUIStore } from '@/stores/useUIStore';

export const CONTEXT_PANEL_MIN_WIDTH = 320;
export const CONTEXT_CHAT_MIN_WIDTH = 320;

export const clampWidth = (width: number, maxWidth: number, minWidth = CONTEXT_PANEL_MIN_WIDTH): number => {
  if (!Number.isFinite(width)) return CONTEXT_ZONE_DEFAULT_WIDTH;
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
};

const maxPanelWidth = (availableWidth: number | null, minWidth = CONTEXT_PANEL_MIN_WIDTH): number => {
  if (availableWidth === null) return Number.POSITIVE_INFINITY;
  return Math.max(minWidth, availableWidth - CONTEXT_CHAT_MIN_WIDTH);
};

export function useContextPanelWidth(mode: ContextPanelMode | null, isExpanded: boolean) {
  const limits = mode ? declaredSurfaceWidth(mode) : null;
  const ownWidthMode = limits ? mode : null;
  const ownWidth = useUIStore((state) => (ownWidthMode ? ownPanelWidth(ownWidthMode, state.contextPanelWidths) : null));
  const docked = isExpanded ? null : limits;
  const clampSideWidth = React.useCallback((next: number, available: number | null) => {
    if (!docked) return clampWidth(next, maxPanelWidth(available));
    return Math.min(docked.maxWidth, clampWidth(next, maxPanelWidth(available, docked.minWidth), docked.minWidth));
  }, [docked]);
  return { ownWidthMode, ownWidth, clampSideWidth };
}
