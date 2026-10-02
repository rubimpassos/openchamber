import * as React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SETTINGS_SELECT_ROW_TRIGGER_CLASS, SETTINGS_SELECT_SIZE } from '@/components/sections/shared/SettingsSection';
import { BUILTIN_BROWSER_PROVIDER, browserProviderGuests } from '@/lib/guests/browser-providers';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { SERVER_BROWSER_GUEST_ID } from './serverBrowserApi';

/**
 * Who answers `browser.*` actions: Server (this extension, built in), This
 * device (the in-app webview/iframe), or another installed extension that
 * provides a browser. Shared by the OpenChamber Tools row and the Browser
 * settings page so both always show the same choices.
 */
export const BrowserEngineSelect: React.FC<{ disabled?: boolean; className?: string }> = ({ disabled, className }) => {
  const { t } = useI18n();
  const browserProvider = useUIStore((state) => state.browserProvider);
  const setBrowserProvider = useUIStore((state) => state.setBrowserProvider);
  const guests = useGuestsStore((state) => state.guests);

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  // Server and This device are core engines, always offered; any other
  // active extension providing `browser` is appended after them.
  const extraGuests = React.useMemo(
    () => browserProviderGuests(guests).filter((guest) => guest.id !== SERVER_BROWSER_GUEST_ID),
    [guests],
  );

  const knownIds = React.useMemo(
    () => new Set([SERVER_BROWSER_GUEST_ID, BUILTIN_BROWSER_PROVIDER, ...extraGuests.map((guest) => guest.id)]),
    [extraGuests],
  );
  // A selection whose extension is gone falls back to Server, the default:
  // the UI store's own default ('builtin') only applies before a value is
  // ever saved.
  const value = knownIds.has(browserProvider) ? browserProvider : SERVER_BROWSER_GUEST_ID;

  const handleChange = React.useCallback((next: string) => {
    setBrowserProvider(next);
    void updateDesktopSettings({ browserProvider: next });
  }, [setBrowserProvider]);

  const labelFor = (id: string | undefined): string => {
    if (id === SERVER_BROWSER_GUEST_ID) return t('settings.openchamber.tools.browserProvider.option.server');
    if (id === BUILTIN_BROWSER_PROVIDER) return t('settings.openchamber.tools.browserProvider.option.builtin');
    return extraGuests.find((guest) => guest.id === id)?.name ?? id ?? '';
  };

  return (
    <Select<string> value={value} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger
        size={SETTINGS_SELECT_SIZE}
        className={className ?? SETTINGS_SELECT_ROW_TRIGGER_CLASS}
        aria-label={t('settings.openchamber.tools.browserProvider.aria')}
      >
        <SelectValue>{(current) => labelFor(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SERVER_BROWSER_GUEST_ID}>{labelFor(SERVER_BROWSER_GUEST_ID)}</SelectItem>
        <SelectItem value={BUILTIN_BROWSER_PROVIDER}>{labelFor(BUILTIN_BROWSER_PROVIDER)}</SelectItem>
        {extraGuests.map((guest) => (
          <SelectItem key={guest.id} value={guest.id}>{guest.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
