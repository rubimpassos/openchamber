import type { ContextPanelDirectoryState, ContextPanelTab } from './types';

export const withParkedBrowserTabs = (
  panel: ContextPanelDirectoryState,
  parked: ContextPanelTab[],
  activeIds: readonly string[] = panel.parkedActiveTabIds ?? [],
): ContextPanelDirectoryState => {
  const next = { ...panel };
  if (parked.length > 0) next.parkedBrowserTabs = parked;
  else delete next.parkedBrowserTabs;
  const parkedIds = new Set(parked.map((tab) => tab.id));
  const parkedActive = [...new Set(activeIds)].filter((id) => parkedIds.has(id));
  if (parkedActive.length > 0) next.parkedActiveTabIds = parkedActive;
  else delete next.parkedActiveTabIds;
  return next;
};
