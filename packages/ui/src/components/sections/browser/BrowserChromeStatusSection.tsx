import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getChromeStatus, isServerBrowserUnavailable, type ChromeStatus } from './serverBrowserApi';

// The install message embeds the apt command inline after "retry: " (see
// chrome-install.js describeMissingLibraries); pulled out so a Copy button
// can target just the command.
const extractAptCommand = (message: string): string | null => {
  const match = /retry:\s*(.+)$/i.exec(message.trim());
  return match ? match[1].trim() : null;
};

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export const BrowserChromeStatusSection: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<ChromeStatus | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const result = await getChromeStatus();
    if (!result.ok) {
      if (isServerBrowserUnavailable(result)) {
        setUnavailable(true);
        return;
      }
      toast.error(t('settings.browser.chrome.loadFailed'));
      return;
    }
    setUnavailable(false);
    setStatus(result.value);
  }, [t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (unavailable) return null;

  const statusLabel = (kind: ChromeStatus['status'] | undefined): string => {
    switch (kind) {
      case 'ready': return t('settings.browser.chrome.status.ready');
      case 'system': return t('settings.browser.chrome.status.system');
      case 'installing': return t('settings.browser.chrome.status.installing');
      case 'missing-libraries': return t('settings.browser.chrome.status.missingLibraries');
      case 'failed': return t('settings.browser.chrome.status.failed');
      default: return t('settings.browser.chrome.status.unknown');
    }
  };

  const dotClass = status?.status === 'ready' || status?.status === 'system'
    ? 'text-[var(--status-success)]'
    : status?.status === 'installing'
      ? 'text-[var(--status-info)]'
      : status?.status === 'missing-libraries' || status?.status === 'failed'
        ? 'text-[var(--status-error)]'
        : 'text-muted-foreground/50';

  const aptCommand = status?.status === 'missing-libraries' && status.message ? extractAptCommand(status.message) : null;

  const handleCopy = async () => {
    if (!aptCommand) return;
    const ok = await copyToClipboard(aptCommand);
    if (!ok) {
      toast.error(t('settings.browser.chrome.command.copyFailed'));
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SettingsSection
      title={t('settings.browser.chrome.title')}
      settingsItem="browser.chrome"
      headerAction={(
        <Button size="xs" variant="ghost" onClick={() => void refresh()} aria-label={t('settings.browser.chrome.refresh.aria')}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          {t('settings.browser.chrome.refresh')}
        </Button>
      )}
    >
      {status === null ? (
        <div className="flex items-center justify-center py-6">
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-busy-pulse" />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Icon name="checkbox-blank-circle-fill" className={cn('size-2.5 shrink-0', dotClass)} />
            <span className="typography-ui-label text-foreground">{statusLabel(status.status)}</span>
          </div>

          {(status.path || status.version) ? (
            <div className="flex flex-col gap-0.5">
              {status.path ? (
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.browser.chrome.path.label')}: <code className="typography-code">{status.path}</code></p>
              ) : null}
              {status.version ? (
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.browser.chrome.version.label')}: {status.version}</p>
              ) : null}
            </div>
          ) : null}

          {status.status === 'failed' && status.message ? (
            <p className={SETTINGS_HELPER_CLASS}>{status.message}</p>
          ) : null}

          {status.status === 'missing-libraries' ? (
            <div className="space-y-2 rounded-lg border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 p-3">
              <p className={SETTINGS_HELPER_CLASS}>{status.message}</p>
              {aptCommand ? (
                <div className="flex items-center gap-2">
                  <code className="typography-code flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
                    {aptCommand}
                  </code>
                  <Button size="xs" variant="outline" onClick={() => void handleCopy()}>
                    {copied ? t('settings.browser.chrome.command.copied') : t('settings.browser.chrome.command.copy')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
};
