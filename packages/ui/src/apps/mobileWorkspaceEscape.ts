import { isVimEditorEventTarget } from '@/lib/editorFocus';
import { isIMECompositionEvent } from '@/lib/ime';
import { hasOpenBackLayer } from '@/lib/mobileBackLayers';
import type { MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';

export const handleMobileWorkspaceEscape = (event: KeyboardEvent, tab: MobileWorkspaceTab, onClose: () => void): void => {
  if (event.key !== 'Escape' || event.defaultPrevented || tab === 'terminal') return;
  if (isVimEditorEventTarget(event.target) || isIMECompositionEvent(event)) return;
  if (hasOpenBackLayer()) return;
  onClose();
};
