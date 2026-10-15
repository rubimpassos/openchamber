import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ServerBrowserDialog, ServerBrowserFileChooser } from '@/lib/browser/serverBrowser/types';

/**
 * What a page in the server browser asks of the person, drawn over the
 * picture: a JavaScript dialog, which pauses the page until it is answered,
 * and a file input the person clicked. Headless Chrome shows neither, so the
 * panel does, the way a local browser would.
 */

// `ownsEscape`: the card answers Escape itself, so the zone does not close on it.
const Card: React.FC<{ children: React.ReactNode; label: string; ownsEscape?: boolean }> = ({ children, label, ownsEscape = false }) => (
  <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
    <div
      role="dialog"
      aria-label={label}
      data-owns-escape={ownsEscape ? 'true' : undefined}
      className="pointer-events-auto flex w-full max-w-[26rem] flex-col gap-3 rounded-lg border border-border bg-[var(--surface-elevated)] p-4 text-[var(--surface-elevated-foreground)] shadow-lg"
    >
      {children}
    </div>
  </div>
);

const originOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : '';
  } catch {
    return '';
  }
};

export const ServerBrowserDialogCard: React.FC<{
  dialog: ServerBrowserDialog;
  /** The page's address, for "<site> says". */
  url: string;
  /** Someone else holds control, so only they can answer. */
  disabled: boolean;
  onAnswer: (accept: boolean, promptText?: string) => Promise<void>;
}> = ({ dialog, url, disabled, onAnswer }) => {
  const { t } = useI18n();
  const [text, setText] = React.useState(dialog.defaultPrompt ?? '');
  const [busy, setBusy] = React.useState(false);
  const okRef = React.useRef<HTMLButtonElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setText(dialog.defaultPrompt ?? '');
    // Like a browser's own dialog: the answer is a keypress away.
    (dialog.type === 'prompt' ? inputRef.current : okRef.current)?.focus();
  }, [dialog.id, dialog.type, dialog.defaultPrompt]);

  const answer = (accept: boolean) => {
    if (busy || disabled) return;
    setBusy(true);
    void onAnswer(accept, dialog.type === 'prompt' && accept ? text : undefined).finally(() => setBusy(false));
  };

  const leave = dialog.type === 'beforeunload';
  const origin = originOf(url);
  const title = leave
    ? t('contextPanel.browser.server.dialog.leaveTitle')
    : origin ? t('contextPanel.browser.server.dialog.says', { origin }) : t('contextPanel.browser.server.dialog.pageSays');
  const message = leave ? t('contextPanel.browser.server.dialog.leaveMessage') : dialog.message;

  return (
    <Card label={title} ownsEscape>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          answer(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          answer(dialog.type === 'alert');
        }}
      >
        <span className="typography-ui-label font-medium" dir="auto">{title}</span>
        {message ? (
          <span className="typography-meta max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground" dir="auto">{message}</span>
        ) : null}
        {dialog.type === 'prompt' ? (
          <Input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={disabled}
            dir="auto"
            aria-label={dialog.message || title}
          />
        ) : null}
        {disabled ? (
          <span className="typography-micro text-muted-foreground">{t('contextPanel.surface.status.otherControls')}</span>
        ) : null}
        <div className="flex justify-end gap-2">
          {dialog.type !== 'alert' ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy || disabled} onClick={() => answer(false)}>
              {leave ? t('contextPanel.browser.server.dialog.stay') : t('contextPanel.browser.server.cancel')}
            </Button>
          ) : null}
          <Button ref={okRef} type="submit" size="sm" disabled={busy || disabled}>
            {leave ? t('contextPanel.browser.server.dialog.leave') : t('contextPanel.browser.server.dialog.ok')}
          </Button>
        </div>
      </form>
    </Card>
  );
};

export const ServerBrowserFileChooserCard: React.FC<{
  chooser: ServerBrowserFileChooser;
  disabled: boolean;
  /** False where files cannot be uploaded from this device. */
  canUpload: boolean;
  onChoose: (files: File[]) => Promise<void>;
  onCancel: () => Promise<void>;
}> = ({ chooser, disabled, canUpload, onChoose, onCancel }) => {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const pickerRef = React.useRef<HTMLInputElement | null>(null);
  const title = chooser.multiple ? t('contextPanel.browser.server.files.requestMany') : t('contextPanel.browser.server.files.requestOne');

  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => setBusy(false));
  };

  return (
    <Card label={title}>
      <div className="flex items-center gap-2">
        <Icon name="upload-2" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="typography-ui-label font-medium">{title}</span>
      </div>
      {chooser.accept ? (
        <span className="typography-micro text-muted-foreground" dir="auto">
          {t('contextPanel.browser.server.files.accepts', { types: chooser.accept })}
        </span>
      ) : null}
      {disabled ? (
        <span className="typography-micro text-muted-foreground">{t('contextPanel.surface.status.otherControls')}</span>
      ) : !canUpload ? (
        <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.server.files.unavailable')}</span>
      ) : null}
      <input
        ref={pickerRef}
        type="file"
        className="hidden"
        accept={chooser.accept || undefined}
        multiple={chooser.multiple}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (picked.length > 0) run(() => onChoose(picked));
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy || disabled} onClick={() => run(onCancel)}>
          {t('contextPanel.browser.server.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || disabled || !canUpload}
          onClick={() => pickerRef.current?.click()}
          autoFocus
        >
          {busy
            ? t('contextPanel.browser.server.files.uploading')
            : chooser.multiple ? t('contextPanel.browser.server.files.chooseMany') : t('contextPanel.browser.server.files.chooseOne')}
        </Button>
      </div>
    </Card>
  );
};
