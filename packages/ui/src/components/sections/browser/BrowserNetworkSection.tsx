import * as React from 'react';

import { toast } from '@/components/ui';
import { SettingsCheckboxRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  getNetworkPolicy,
  isServerBrowserUnavailable,
  setNetworkPolicy,
  type NetworkPolicyState,
} from './serverBrowserApi';

/** Settings → Browser → Network: may pages open localhost and the LAN. */
export const BrowserNetworkSection: React.FC = () => {
  const { t } = useI18n();
  const [policy, setPolicy] = React.useState<NetworkPolicyState | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void getNetworkPolicy().then((result) => {
      if (cancelled) return;
      if (result.ok) setPolicy(result.value);
      else if (isServerBrowserUnavailable(result)) setUnavailable(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (unavailable || !policy) return null;

  const change = (checked: boolean) => {
    setSaving(true);
    // Choosing the default again forgets the choice, so a move to another
    // machine (or the guess improving) is not pinned by an old click.
    const value = checked === policy.defaultValue ? null : checked;
    void setNetworkPolicy(value).then((result) => {
      if (result.ok) setPolicy(result.value);
      else toast.error(t('settings.browser.network.saveFailed'));
    }).finally(() => setSaving(false));
  };

  return (
    <SettingsSection title={t('settings.browser.network.title')} settingsItem="browser.network">
      <SettingsCheckboxRow
        checked={policy.allowPrivateNetwork}
        onChange={change}
        disabled={saving}
        label={t('settings.browser.network.allowPrivate.label')}
        description={t('settings.browser.network.allowPrivate.description')}
      />
      <p className={SETTINGS_HELPER_CLASS}>
        {t('settings.browser.network.allowPrivate.default', {
          value: policy.defaultValue ? t('settings.browser.network.allowPrivate.on') : t('settings.browser.network.allowPrivate.off'),
        })}
      </p>
    </SettingsSection>
  );
};
