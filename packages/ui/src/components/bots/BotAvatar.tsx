import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useAvatarImage } from '@/hooks/useAvatarImage';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BotAvatarError, botInitials, readBotAvatar, type BotAvatarFailure } from './botAvatarImage';

const sizes = {
  sm: { box: 'size-5 typography-micro', letters: 1 },
  md: { box: 'size-9 typography-ui-label', letters: 2 },
  lg: { box: 'size-14 typography-ui-header', letters: 2 },
} as const;
const failureKeys = {
  type: 'bots.avatar.error.type', size: 'bots.avatar.error.size', decode: 'bots.avatar.error.decode',
} satisfies Record<BotAvatarFailure, I18nKey>;

export function BotAvatar({ name, avatar, size = 'sm', described = false, className }: {
  readonly name: string; readonly avatar?: string | null; readonly size?: keyof typeof sizes;
  readonly described?: boolean; readonly className?: string;
}) {
  const image = useAvatarImage(avatar);
  const { box, letters } = sizes[size];
  return <span role={described ? 'img' : undefined} aria-label={described ? name : undefined} aria-hidden={described ? undefined : true}
    className={cn('oc-tile-inset relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium text-muted-foreground', box, className)}>
    <span aria-hidden="true">{botInitials(name, letters)}</span>
    {avatar && !image.broken ? <img src={avatar} alt="" draggable={false} onError={image.onError} className="absolute inset-0 size-full object-cover" /> : null}
  </span>;
}

export function BotAvatarField({ name, value, onChange }: {
  readonly name: string; readonly value: string | null | undefined; readonly onChange: (avatar: string | null) => void;
}) {
  const { t } = useI18n();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<BotAvatarFailure | null>(null);
  const pick = async (file: File) => {
    setBusy(true);
    setFailure(null);
    try {
      onChange(await readBotAvatar(file));
    } catch (error) {
      if (!(error instanceof BotAvatarError)) throw error;
      setFailure(error.reason);
    } finally {
      setBusy(false);
    }
  };
  return <SettingsStackedField label={t('bots.avatar.label')} controlClassName="max-w-none flex-wrap">
    <BotAvatar name={name} avatar={value} size="lg" described />
    <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload-2" />{t('bots.avatar.change')}</Button>
    {value ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setFailure(null); onChange(null); }}>{t('bots.avatar.remove')}</Button> : null}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" tabIndex={-1} aria-hidden="true"
      onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void pick(file); }} />
    <p className="min-h-5 w-full typography-meta text-[var(--status-error-text)]" role="alert">{failure ? t(failureKeys[failure]) : null}</p>
  </SettingsStackedField>;
}
