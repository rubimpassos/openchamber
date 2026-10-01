import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SurfaceConnectionState, SurfaceControlState } from '@/lib/guests/surface-client';
import type { ServerBrowserChromeStatus, ServerBrowserHelp } from '@/lib/browser/serverBrowser/types';

/**
 * The bars stacked above the page picture: who holds control right now, a
 * help request aimed at this chat, and the service's Chrome install status.
 * A help request replaces the control bar, except while this viewer holds
 * control: then both show, since "Hand back" is what answers the request.
 */

const ControlBar: React.FC<{
  control: SurfaceControlState;
  connection: SurfaceConnectionState;
  focused: boolean;
  onHandBack: () => void;
}> = ({ control, connection, focused, onHandBack }) => {
  const { t } = useI18n();

  if (control.controller === 'user' && control.mine) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <span className="typography-meta text-foreground">{t('contextPanel.browser.server.control.bar')}</span>
        <Button size="xs" variant="outline" className="ml-auto" onClick={onHandBack}>
          {t('contextPanel.surface.handBack')}
        </Button>
      </div>
    );
  }

  if (control.controller === 'user' && !control.mine) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <span className="typography-meta text-muted-foreground">{t('contextPanel.surface.status.otherControls')}</span>
      </div>
    );
  }

  if (control.controller === 'agent') {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="typography-meta text-muted-foreground">{t('contextPanel.browser.server.control.agentWorking')}</span>
      </div>
    );
  }

  if (connection.status === 'ended' || connection.status === 'reconnecting' || connection.status === 'connecting') return null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
      <span className="typography-meta text-muted-foreground" aria-live="polite">
        {focused ? t('contextPanel.surface.status.readyFocused') : t('contextPanel.browser.server.control.hint')}
      </span>
    </div>
  );
};

const HelpBanner: React.FC<{
  help: ServerBrowserHelp;
  onSaveSignIn: () => void;
  saving: boolean;
}> = ({ help, onSaveSignIn, saving }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-[color-mix(in_srgb,var(--status-warning)_12%,var(--surface-elevated))] px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="user" className="size-3.5 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
        <span className="typography-meta min-w-0 flex-1 text-foreground">
          {t('contextPanel.browser.server.help.banner', { reason: help.reason })}
        </span>
      </div>
      {help.kind === 'login' ? (
        <div className="flex items-center justify-between gap-2 pl-5.5">
          <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.server.help.loginHint')}</span>
          <Button size="xs" variant="outline" disabled={saving} onClick={onSaveSignIn}>
            <Icon name="save-3" className="size-3.5" aria-hidden="true" />
            {t('contextPanel.browser.server.help.saveSignIn')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

const ChromeStatusBanner: React.FC<{ chrome: ServerBrowserChromeStatus }> = ({ chrome }) => {
  const { t } = useI18n();

  const copyCommand = async () => {
    const result = await copyTextToClipboard(chrome.message);
    toast[result.ok ? 'success' : 'error'](result.ok
      ? t('contextPanel.browser.server.chrome.copied')
      : t('contextPanel.browser.clearFailed'));
  };

  if (chrome.status === 'ready' || chrome.status === 'system') return null;

  const title = chrome.status === 'installing'
    ? t('contextPanel.browser.server.chrome.installing')
    : chrome.status === 'missing-libraries'
      ? t('contextPanel.browser.server.chrome.missingLibraries')
      : t('contextPanel.browser.server.chrome.failed');

  return (
    <div className="flex flex-col gap-1 border-b border-border bg-[color-mix(in_srgb,var(--status-error)_10%,var(--surface-elevated))] px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon
          name={chrome.status === 'installing' ? 'download-cloud' : 'error-warning'}
          className={cn(
            'size-3.5 shrink-0',
            chrome.status === 'installing' ? 'animate-pulse text-muted-foreground' : 'text-[var(--status-error)]',
          )}
          aria-hidden="true"
        />
        <span className="typography-meta text-foreground">{title}</span>
      </div>
      {chrome.message ? (
        <div className="flex items-center justify-between gap-2 pl-5.5">
          <span className="typography-micro whitespace-pre-wrap text-muted-foreground">{chrome.message}</span>
          {chrome.status === 'missing-libraries' ? (
            <Button size="xs" variant="outline" onClick={() => void copyCommand()}>
              <Icon name="file-copy" className="size-3.5" aria-hidden="true" />
              {t('contextPanel.browser.server.chrome.copyCommand')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ServerBrowserBanners: React.FC<{
  control: SurfaceControlState;
  connection: SurfaceConnectionState;
  focused: boolean;
  onHandBack: () => void;
  help: ServerBrowserHelp | null;
  helpTargetsThisScope: boolean;
  onSaveSignIn: () => void;
  savingSignIn: boolean;
  chrome: ServerBrowserChromeStatus | null;
}> = ({ control, connection, focused, onHandBack, help, helpTargetsThisScope, onSaveSignIn, savingSignIn, chrome }) => (
  <>
    {chrome ? <ChromeStatusBanner chrome={chrome} /> : null}
    {help && helpTargetsThisScope ? (
      <>
        <HelpBanner help={help} onSaveSignIn={onSaveSignIn} saving={savingSignIn} />
        {/* Handing back is how the user answers the request, so the bar with
            that button has to stay while they hold control. */}
        {control.controller === 'user' && control.mine ? (
          <ControlBar control={control} connection={connection} focused={focused} onHandBack={onHandBack} />
        ) : null}
      </>
    ) : (
      <ControlBar control={control} connection={connection} focused={focused} onHandBack={onHandBack} />
    )}
  </>
);
