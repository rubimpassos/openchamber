import * as React from 'react';

import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SETTINGS_FIELD_LABEL_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { BrowserEngineSelect } from './BrowserEngineSelect';
import { BrowserProfilesSection } from './BrowserProfilesSection';
import { BrowserChromeStatusSection } from './BrowserChromeStatusSection';
import { BrowserNetworkSection } from './BrowserNetworkSection';

export const BrowserPage: React.FC = () => {
  const { t } = useI18n();

  return (
    <SettingsPageLayout
      title={t('settings.page.browser.title')}
      description={t('settings.page.browser.description')}
      showSaveStatus
    >
      <SettingsSection title={t('settings.browser.engine.title')} divider={false} settingsItem="browser.engine">
        <div className="flex items-center gap-3">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.tools.browserProvider.label')}</span>
          <BrowserEngineSelect />
        </div>
      </SettingsSection>

      <BrowserNetworkSection />
      <BrowserProfilesSection />
      <BrowserChromeStatusSection />
    </SettingsPageLayout>
  );
};
