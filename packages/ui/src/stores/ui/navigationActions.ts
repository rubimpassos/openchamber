import type { UIStoreSlice } from './types';
import { isVSCodeRuntime } from '@/lib/desktop';

export const createNavigationActions: UIStoreSlice<
  | 'toggleExpandedInput'
  | 'setExpandedInput'
  | 'setSessionSwitcherOpen'
  | 'setSessionDropdownOpen'
  | 'setPendingDiffFile'
  | 'setPendingTurnDiffFile'
  | 'setPendingFileNavigation'
  | 'setPendingFileFocusPath'
  | 'navigateToDiff'
  | 'consumePendingDiffFile'
  | 'setIsMobile'
  | 'toggleCommandPalette'
  | 'setCommandPaletteOpen'
  | 'toggleHelpDialog'
  | 'setHelpDialogOpen'
  | 'setProjectActionsDialogOpen'
  | 'setAboutDialogOpen'
  | 'setOpenCodeStatusDialogOpen'
  | 'setOpenCodeStatusText'
  | 'setSessionCreateDialogOpen'
  | 'setScheduledTasksDialogOpen'
  | 'setSuggestedTasksPageOpen'
  | 'setBotsPageOpen'
  | 'setBotsPageTarget'
  | 'setArchivePageOpen'
  | 'setIntegrationsCatalogOpen'
  | 'setUsageStatsPageOpen'
  | 'setSourceBoardOpen'
  | 'setOverviewOpen'
  | 'setWorktreesPageProjectId'
  | 'setSpacesPageProjectId'
  | 'setOpenGuestPage'
  | 'closeMainSurfaces'
  | 'setSettingsDialogOpen'
  | 'setNewWorktreeDialogOpen'
  | 'setModelSelectorOpen'
  | 'setSidebarSection'
  | 'setSettingsPage'
  | 'setSettingsProvidersClassificationRequested'
  | 'setSettingsProvidersOpenRequested'
  | 'requestSettingsJump'
  | 'openSettingsAt'
  | 'clearSettingsJumpRequest'
  | 'setSettingsProvidersConnectRequested'
  | 'setSettingsProjectPath'
  | 'setSettingsProjectsSelectedId'
  | 'setSettingsRemoteInstancesSelectedId'
  | 'setEventStreamStatus'
  | 'setRunOverviewKey'
  | 'requestParallelComposer'
  | 'consumeParallelComposerRequest'
  | 'setTimelineDialogOpen'
  | 'setPromptNavigatorPanelOpen'
  | 'togglePromptNavigatorPanel'
  | 'setImagePreviewOpen'
  | 'viewPagerPage'
  | 'setViewPagerPage'
> = (set, get) => ({
  toggleExpandedInput: () => {
    set((state) => ({ isExpandedInput: !state.isExpandedInput }));
  },

  setExpandedInput: (value) => {
    set({ isExpandedInput: value });
  },
  setSessionSwitcherOpen: (open) => {
    if (get().isSessionSwitcherOpen === open) {
      return;
    }
    set({ isSessionSwitcherOpen: open });
  },

  setSessionDropdownOpen: (open) => {
    if (get().isSessionDropdownOpen === open) {
      return;
    }
    set({ isSessionDropdownOpen: open });
  },

  setPendingDiffFile: (filePath, staged = false, scope = null) => {
    set({
      pendingDiffFile: filePath,
      pendingDiffStaged: filePath ? staged : false,
      pendingDiffScope: filePath ? scope : null,
    });
  },

  setPendingTurnDiffFile: (request) => {
    set({ pendingTurnDiffFile: request });
  },

  setPendingFileNavigation: (navigation) => {
    set({ pendingFileNavigation: navigation });
  },

  setPendingFileFocusPath: (path) => {
    set({ pendingFileFocusPath: path });
  },

  navigateToDiff: (filePath, staged = false, scope = null) => {
    set({ pendingDiffFile: filePath, pendingDiffStaged: staged, pendingDiffScope: scope });
  },

  consumePendingDiffFile: () => {
    const { pendingDiffFile } = get();
    if (pendingDiffFile) {
      set({ pendingDiffFile: null, pendingDiffStaged: false, pendingDiffScope: null });
    }
    return pendingDiffFile;
  },

  setIsMobile: (isMobile) => {
    set({ isMobile });
  },

  toggleCommandPalette: () => {
    set((state) => ({ isCommandPaletteOpen: !state.isCommandPaletteOpen }));
  },

  setCommandPaletteOpen: (open) => {
    set({ isCommandPaletteOpen: open });
  },

  toggleHelpDialog: () => {
    set((state) => ({ isHelpDialogOpen: !state.isHelpDialogOpen }));
  },

  setHelpDialogOpen: (open) => {
    set({ isHelpDialogOpen: open });
  },

  setProjectActionsDialogOpen: (open) => {
    set({ isProjectActionsDialogOpen: open });
  },

  setAboutDialogOpen: (open) => {
    set({ isAboutDialogOpen: open });
  },

  setOpenCodeStatusDialogOpen: (open) => {
    set({ isOpenCodeStatusDialogOpen: open });
  },

  setOpenCodeStatusText: (text) => {
    set({ openCodeStatusText: text });
  },

  setSessionCreateDialogOpen: (open) => {
    set({ isSessionCreateDialogOpen: open });
  },

  setScheduledTasksDialogOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isScheduledTasksDialogOpen: true, isSuggestedTasksPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isScheduledTasksDialogOpen: false });
  },

  setSuggestedTasksPageOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isSuggestedTasksPageOpen: true, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isSuggestedTasksPageOpen: false });
  },

  setBotsPageOpen: (open) => {
    if (isVSCodeRuntime()) return;
    set(open
      ? { isBotsPageOpen: true, isOverviewOpen: false, isSuggestedTasksPageOpen: false, isScheduledTasksDialogOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isBotsPageOpen: false, botsPageTarget: null });
  },

  setBotsPageTarget: (botsPageTarget) => set({ botsPageTarget }),

  setArchivePageOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isArchivePageOpen: true, archivePageOpenCount: get().archivePageOpenCount + 1, isUsageStatsPageOpen: false, isIntegrationsCatalogOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isArchivePageOpen: false });
  },

  setIntegrationsCatalogOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isIntegrationsCatalogOpen: true, isArchivePageOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isIntegrationsCatalogOpen: false });
  },

  setUsageStatsPageOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isUsageStatsPageOpen: true, isSourceBoardOpen: false, isOverviewOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isUsageStatsPageOpen: false });
  },

  setSourceBoardOpen: (open) => {
    set(open
      ? { isBotsPageOpen: false, botsPageTarget: null, isSourceBoardOpen: true, isOverviewOpen: false, isUsageStatsPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isSourceBoardOpen: false });
  },

  setOverviewOpen: (open) => {
    if (open && !get().overviewFeatureAvailable) return;
    set(open
      ? { isOverviewOpen: true, isBotsPageOpen: false, botsPageTarget: null, isSourceBoardOpen: false, isUsageStatsPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null, openGuestPageId: null }
      : { isOverviewOpen: false });
  },

  setWorktreesPageProjectId: (projectId) => {
    set(projectId
      ? { isBotsPageOpen: false, botsPageTarget: null, worktreesPageProjectId: projectId, spacesPageProjectId: null, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, runOverviewKey: null, openGuestPageId: null }
      : { worktreesPageProjectId: null });
  },

  setSpacesPageProjectId: (projectId) => {
    set(projectId
      ? { isBotsPageOpen: false, botsPageTarget: null, spacesPageProjectId: projectId, worktreesPageProjectId: null, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, runOverviewKey: null, openGuestPageId: null }
      : { spacesPageProjectId: null });
  },

  setOpenGuestPage: (id) => {
    set(id ? { isBotsPageOpen: false, botsPageTarget: null, openGuestPageId: id, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, runOverviewKey: null }
      : { openGuestPageId: null });
  },

  closeMainSurfaces: () => {
    const state = get();
    if (!state.isBotsPageOpen && !state.botsPageTarget && !state.isScheduledTasksDialogOpen && !state.isSuggestedTasksPageOpen && !state.isArchivePageOpen && !state.isIntegrationsCatalogOpen && !state.isUsageStatsPageOpen && !state.isSourceBoardOpen && !state.isOverviewOpen && !state.worktreesPageProjectId && !state.spacesPageProjectId && !state.runOverviewKey && !state.openGuestPageId) {
      return;
    }
    set({
      isScheduledTasksDialogOpen: false,
      isSuggestedTasksPageOpen: false,
      isBotsPageOpen: false,
      botsPageTarget: null,
      isArchivePageOpen: false,
      isIntegrationsCatalogOpen: false,
      isUsageStatsPageOpen: false,
      isSourceBoardOpen: false,
      isOverviewOpen: false,
      worktreesPageProjectId: null,
      spacesPageProjectId: null,
      runOverviewKey: null,
      openGuestPageId: null,
    });
  },

  setSettingsDialogOpen: (open) => {
    set((state) => {
      if (!open) {
        return { isSettingsDialogOpen: false };
      }
      if (state.settingsHasOpenedOnce) {
        return { isSettingsDialogOpen: true };
      }
      return { isSettingsDialogOpen: true, settingsHasOpenedOnce: true };
    });
  },

  setNewWorktreeDialogOpen: (open) => {
    set({ isNewWorktreeDialogOpen: open });
  },

  setModelSelectorOpen: (open) => {
    set({ isModelSelectorOpen: open });
  },

  setSidebarSection: (section) => {
    set({ sidebarSection: section });
  },

  setSettingsPage: (slug) => {
    set({ settingsPage: slug });
  },

  setSettingsProvidersClassificationRequested: (requested) => {
    set({ settingsProvidersClassificationRequested: requested });
  },

  setSettingsProvidersOpenRequested: (providerId) => {
    set({ settingsProvidersOpenRequested: providerId });
  },

  requestSettingsJump: (page, itemId = null) => {
    set({ settingsJumpRequest: { page, itemId } });
  },

  openSettingsAt: (page, itemId = null) => {
    get().requestSettingsJump(page, itemId);
    get().setSettingsDialogOpen(true);
  },

  clearSettingsJumpRequest: () => {
    set({ settingsJumpRequest: null });
  },

  setSettingsProvidersConnectRequested: (requested) => {
    set({ settingsProvidersConnectRequested: requested });
  },

  setSettingsProjectPath: (path) => {
    const trimmed = path?.trim();
    set({ settingsProjectPath: trimmed ? trimmed : null });
  },

  setSettingsProjectsSelectedId: (projectId) => {
    set({ settingsProjectsSelectedId: projectId });
  },

  setSettingsRemoteInstancesSelectedId: (instanceId) => {
    set({ settingsRemoteInstancesSelectedId: instanceId });
  },

  setEventStreamStatus: (status, hint) => {
    set({
      eventStreamStatus: status,
      eventStreamHint: hint ?? null,
    });
  },

  setRunOverviewKey: (runKey) => {
    set(runKey
      ? { isBotsPageOpen: false, botsPageTarget: null, runOverviewKey: runKey, isSessionSwitcherOpen: false, isScheduledTasksDialogOpen: false, isSuggestedTasksPageOpen: false, isArchivePageOpen: false, isIntegrationsCatalogOpen: false, isUsageStatsPageOpen: false, isSourceBoardOpen: false, isOverviewOpen: false, worktreesPageProjectId: null, spacesPageProjectId: null, openGuestPageId: null }
      : { runOverviewKey: null });
  },

  requestParallelComposer: (prompt = '') => {
    set((state) => ({
      parallelComposerRequest: { id: (state.parallelComposerRequest?.id ?? 0) + 1, prompt },
      isSessionSwitcherOpen: false,
    }));
  },

  consumeParallelComposerRequest: (id) => {
    if (get().parallelComposerRequest?.id !== id) return;
    set({ parallelComposerRequest: null });
  },

  setTimelineDialogOpen: (open) => {
    set({ isTimelineDialogOpen: open });
  },

  setPromptNavigatorPanelOpen: (open) => {
    set({ isPromptNavigatorPanelOpen: open });
  },

  togglePromptNavigatorPanel: () => {
    set((state) => ({ isPromptNavigatorPanelOpen: !state.isPromptNavigatorPanelOpen }));
  },

  setImagePreviewOpen: (open) => {
    set({ isImagePreviewOpen: open });
  },

  viewPagerPage: 'center',

  setViewPagerPage: (page: 'left' | 'center' | 'right') => {
    set({ viewPagerPage: page });
    set({ isSessionSwitcherOpen: page === 'left' });
  },
});
