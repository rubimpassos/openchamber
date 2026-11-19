import React from 'react';
import { SettingsChipGroup, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { ProviderAccountMode, ProviderAccountModeState } from './useProviderAccountMode';

export const ProviderAccountModeField: React.FC<{
  state: ProviderAccountModeState;
  /** Stored accounts requests can go through; switching needs two. */
  accountCount: number;
  /** The account a new preferred mode starts on: the active one. */
  activeId: string | null;
}> = ({ state, accountCount, activeId }) => {
  const { t } = useI18n();
  if (state.mode === null) return null;
  const canSwitch = accountCount > 1;
  const choose = (mode: ProviderAccountMode) => {
    if (mode === state.mode) return;
    void state.setMode(mode, state.preferredId ?? activeId);
  };
  return (
    <SettingsFieldRow
      label={t('settings.providers.accounts.mode.label')}
      info={t('settings.providers.accounts.mode.info')}
      description={canSwitch ? undefined : t('settings.providers.accounts.switchOnLimitNeedsAccounts')}
    >
      <SettingsChipGroup<ProviderAccountMode>
        value={canSwitch ? state.mode : 'fixed'}
        onChange={choose}
        aria-label={t('settings.providers.accounts.mode.label')}
        options={[
          { value: 'automatic', label: t('settings.providers.accounts.mode.automatic'), disabled: !canSwitch },
          { value: 'preferred', label: t('settings.providers.accounts.mode.preferred'), disabled: !canSwitch || activeId === null },
          { value: 'fixed', label: t('settings.providers.accounts.mode.fixed'), disabled: !canSwitch },
        ]}
      />
    </SettingsFieldRow>
  );
};
