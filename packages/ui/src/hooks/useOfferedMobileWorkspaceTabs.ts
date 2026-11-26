import React from 'react';

import { usePhoneGuestPanelModes } from '@/hooks/useGuestSurfaces';
import { phoneGuestPanelModes } from '@/lib/guests/phone';
import { useGuestsStore } from '@/lib/guests/store';
import { offeredMobileWorkspaceTabs, type OfferedMobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { useUIStore } from '@/stores/useUIStore';

export const readOfferedMobileWorkspaceTabs = (): readonly OfferedMobileWorkspaceTab[] => offeredMobileWorkspaceTabs(
  phoneGuestPanelModes(useGuestsStore.getState().guests),
  useUIStore.getState().browserProvider,
);

export const useOfferedMobileWorkspaceTabs = (): readonly OfferedMobileWorkspaceTab[] => {
  const extensions = usePhoneGuestPanelModes();
  const browserProvider = useUIStore((state) => state.browserProvider);
  return React.useMemo(() => offeredMobileWorkspaceTabs(extensions, browserProvider), [browserProvider, extensions]);
};
