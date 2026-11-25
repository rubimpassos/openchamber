import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ButtonTooltip, ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  FILL_VIEWPORT,
  VIEWPORT_PRESETS,
  clampViewportSize,
  presetViewport,
  rotateViewport,
  viewportSize,
  type BrowserViewport,
} from '@/lib/browser/viewport';

export type BrowserColorScheme = 'system' | 'light' | 'dark';

const RESPONSIVE = 'responsive';

type ViewportSide = 'width' | 'height';

const SCHEMES: ReadonlyArray<{ value: BrowserColorScheme; icon: IconName }> = [
  { value: 'system', icon: 'contrast-2' },
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
];

export const BrowserDeviceBar: React.FC<{
  viewport: BrowserViewport;
  onViewportChange: (viewport: BrowserViewport) => void;
  colorScheme: BrowserColorScheme;
  onColorSchemeChange: (scheme: BrowserColorScheme) => void;
  scale: number;
  panelSize: { width: number; height: number };
}> = ({ viewport, onViewportChange, colorScheme, onColorSchemeChange, scale, panelSize }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [presetSheetOpen, setPresetSheetOpen] = React.useState(false);
  const presetLabelId = React.useId();
  const size = viewportSize(viewport);
  const presetId = viewport.kind === 'preset' ? viewport.id : RESPONSIVE;
  const presetLabel = (id: string) => (
    id === RESPONSIVE ? t('contextPanel.browser.device.responsive') : VIEWPORT_PRESETS.find((preset) => preset.id === id)?.label ?? id
  );
  const choosePreset = (id: string) => onViewportChange(id === RESPONSIVE ? FILL_VIEWPORT : presetViewport(id) ?? FILL_VIEWPORT);
  const shownPanelSize = { width: Math.round(panelSize.width), height: Math.round(panelSize.height) };

  const [draft, setDraft] = React.useState<{ side: ViewportSide; digits: string } | null>(null);
  const heightInputRef = React.useRef<HTMLInputElement | null>(null);

  const commitDraft = () => {
    setDraft(null);
    if (!draft) return;
    const { side } = draft;
    const parsed = Number.parseInt(draft.digits, 10);
    if (!Number.isFinite(parsed)) return;
    const current = size ?? shownPanelSize;
    onViewportChange({
      kind: 'custom',
      width: clampViewportSize(side === 'width' ? parsed : current.width),
      height: clampViewportSize(side === 'height' ? parsed : current.height),
    });
  };

  const sizeInput = (side: ViewportSide) => ({
    value: draft?.side === side ? draft.digits : size ? String(size[side]) : '',
    placeholder: shownPanelSize[side] > 0 ? String(shownPanelSize[side]) : '',
    type: 'text',
    inputMode: 'numeric',
    pattern: '[0-9]*',
    autoComplete: 'off',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ side, digits: event.target.value.replace(/\D/g, '') }),
    onBlur: commitDraft,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setDraft(null);
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (side === 'width') heightInputRef.current?.focus();
      else event.currentTarget.blur();
    },
  } satisfies React.ComponentProps<'input'>);

  const sizeInputClass = cn(
    'w-11 min-w-0 bg-transparent text-center typography-meta tabular-nums text-foreground outline-none',
    'placeholder:text-muted-foreground',
  );

  return (
    <div className="@container flex min-w-0 items-center gap-1.5 px-2 pb-1.5">
      {isMobile ? (
        <>
          <button
            type="button"
            aria-label={t('contextPanel.browser.device.preset')}
            aria-describedby={presetLabelId}
            aria-haspopup="dialog"
            aria-expanded={presetSheetOpen}
            onClick={() => setPresetSheetOpen(true)}
            className={cn(dropdownTriggerVariants(), 'w-fit min-w-0 max-w-[12rem] shrink')}
          >
            <span id={presetLabelId} className="min-w-0 flex-1 truncate">{presetLabel(presetId)}</span>
            <Icon name="arrow-down-s" className="size-4 opacity-50" aria-hidden="true" />
          </button>
          <MobileOverlayPanel
            open={presetSheetOpen}
            title={t('contextPanel.browser.device.preset')}
            onClose={() => setPresetSheetOpen(false)}
          >
            {[RESPONSIVE, ...VIEWPORT_PRESETS.map((preset) => preset.id)].map((id) => (
              <MobileSheetRow
                key={id}
                selected={id === presetId}
                onClick={() => {
                  choosePreset(id);
                  setPresetSheetOpen(false);
                }}
              >
                {presetLabel(id)}
              </MobileSheetRow>
            ))}
          </MobileOverlayPanel>
        </>
      ) : (
        <Select<string> value={presetId} onValueChange={choosePreset}>
          <SelectTrigger className="min-w-0 max-w-[12rem] shrink" aria-label={t('contextPanel.browser.device.preset')}>
            <SelectValue>{(value) => presetLabel(String(value))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={RESPONSIVE}>{t('contextPanel.browser.device.responsive')}</SelectItem>
            {VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="oc-raised oc-field flex min-h-7 shrink-0 items-center rounded-md bg-[var(--surface-elevated)] px-1">
        <input
          {...sizeInput('width')}
          enterKeyHint="next"
          aria-label={t('contextPanel.browser.device.width')}
          className={sizeInputClass}
        />
        <span className="typography-meta text-muted-foreground" aria-hidden="true">×</span>
        <input
          {...sizeInput('height')}
          ref={heightInputRef}
          enterKeyHint="done"
          aria-label={t('contextPanel.browser.device.height')}
          className={sizeInputClass}
        />
      </div>
      <ToolbarTooltipButton
        icon="anticlockwise-2"
        label={t('contextPanel.browser.device.rotate')}
        onClick={() => onViewportChange(rotateViewport(viewport))}
        disabled={!size}
      />

      {size && scale < 1 ? (
        <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
      ) : null}

      <div
        role="group"
        aria-label={t('contextPanel.browser.device.scheme')}
        className="oc-recessed ms-auto inline-flex min-h-7 shrink-0 items-center gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5"
      >
        {SCHEMES.map(({ value, icon }) => {
          const selected = colorScheme === value;
          const schemeLabel = t(value === 'system'
            ? 'contextPanel.browser.device.schemeSystem'
            : value === 'light'
              ? 'contextPanel.browser.device.schemeLight'
              : 'contextPanel.browser.device.schemeDark');
          return (
            <ButtonTooltip
              key={value}
              side="bottom"
              label={t(value === 'system'
                ? 'contextTooltips.terminalBrowser.device.schemeSystem'
                : value === 'light'
                  ? 'contextTooltips.terminalBrowser.device.schemeLight'
                  : 'contextTooltips.terminalBrowser.device.schemeDark')}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={selected}
                aria-label={schemeLabel}
                onClick={() => onColorSchemeChange(value)}
                className={cn(
                  'h-6 gap-1.5 rounded-md px-2 typography-meta !font-normal',
                  selected
                    ? 'oc-raised bg-[var(--surface-background)] text-foreground hover:bg-[var(--surface-background)] dark:bg-[var(--surface-elevated)] dark:hover:bg-[var(--surface-elevated)]'
                    : 'text-muted-foreground hover:bg-transparent hover:text-foreground',
                )}
              >
                <Icon name={icon} className="size-3.5" aria-hidden="true" />
                <span className="hidden @md:inline">{schemeLabel}</span>
              </Button>
            </ButtonTooltip>
          );
        })}
      </div>
    </div>
  );
};
