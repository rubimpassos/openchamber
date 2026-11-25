import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ActionToolbar, ButtonTooltip, ToolbarTooltipButton, type ToolbarAction, type ToolbarGroup } from '@/components/ui/action-toolbar';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { BrowserAddressSuggestions } from './BrowserAddressSuggestions';
import type { BrowserHistoryEntry } from '@/lib/browser/history';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import type { IconName } from '@/components/icon/icons';
import { rowActionsThatFit } from './browserToolbarRoom';

const splitAddress = (address: string): { host: string; rest: string } | null => {
  const match = /^(https?:\/\/)?([^/?#\s]+)(.*)$/i.exec(address.trim());
  if (!match) return null;
  return { host: match[2], rest: match[3] };
};

export type BrowserToolbarMenuItem =
  | { kind: 'item'; id: string; icon: IconName; label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean; pressed?: boolean }
  | { kind: 'separator'; id: string };

const ROW_PADDING_PX = 16;
const ROW_GAP_PX = 6;

const measureRowRoom = (row: HTMLElement): number | null => {
  const nav = row.querySelector<HTMLElement>('[data-browser-toolbar-nav]');
  const navButtons = nav?.querySelectorAll('button').length ?? 0;
  if (!nav || navButtons === 0 || row.clientWidth === 0) return null;
  const pinned = Array.from(row.querySelectorAll<HTMLElement>('[data-browser-toolbar-pinned]'));
  const pinnedWidth = pinned.reduce((total, element) => total + element.offsetWidth + ROW_GAP_PX, 0);
  return rowActionsThatFit({
    rowWidth: row.clientWidth,
    takenWidth: ROW_PADDING_PX + nav.offsetWidth + ROW_GAP_PX * 2 + pinnedWidth,
    buttonWidth: nav.offsetWidth / navButtons,
  });
};

type BrowserToolbarProps = {
  address: string;
  addressMark?: { icon: IconName; label: string };
  suggestions?: readonly BrowserHistoryEntry[];
  onForgetSuggestion?: (url: string) => void;
  onAddressChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onHome?: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  canOpenExternal?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  onAnnotate?: () => void;
  onOpenDevTools?: () => void;
  onToggleDevTools?: () => void;
  isDevToolsOpen?: boolean;
  onToggleKeyboard?: () => void;
  isKeyboardOpen?: boolean;
  /** The server browser's console/network drawer, shown instead of `onOpenDevTools`. */
  onToggleInspector?: () => void;
  isInspectorOpen?: boolean;
  isAnnotating?: boolean;
  onHardReload?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  zoomPercent?: number;
  onClearCookies?: () => void;
  onClearCache?: () => void;
  onToggleDeviceBar?: () => void;
  isDeviceBarOpen?: boolean;
  /** The page's sound, for a browser that streams it; hidden without a handler. */
  /** Server Browser: the robot that turns "Follow agent" on and off for this chat. */
  onToggleFollowAgent?: () => void;
  isFollowingAgent?: boolean;
  onToggleSound?: () => void;
  isSoundOn?: boolean;
  /** Sound is on but the page sends none. */
  isSoundUnavailable?: boolean;
  /**
   * Rarely used actions behind a ⋯ button at the end of the bar. When given,
   * "open in external browser" lives here instead of as its own button.
   */
  menuItems?: readonly BrowserToolbarMenuItem[];
};

export const BrowserToolbar: React.FC<BrowserToolbarProps> = ({
  address,
  addressMark,
  suggestions = [],
  onForgetSuggestion,
  onAddressChange,
  onSubmit,
  onHome,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  canOpenExternal = true,
  canGoBack,
  canGoForward,
  isLoading,
  onAnnotate,
  onOpenDevTools,
  onToggleDevTools,
  isDevToolsOpen,
  onToggleKeyboard,
  isKeyboardOpen,
  onToggleInspector,
  isInspectorOpen,
  isAnnotating,
  onHardReload,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  zoomPercent = 100,
  onClearCookies,
  onClearCache,
  menuItems,
  onToggleDeviceBar,
  isDeviceBarOpen,
  onToggleFollowAgent,
  isFollowingAgent,
  onToggleSound,
  isSoundOn,
  isSoundUnavailable,
}) => {
  const { t } = useI18n();
  const soundIconName: IconName = isSoundOn ? 'volume-up' : 'volume-mute';
  const followAgentIconName: IconName = isFollowingAgent ? 'robot-2-fill' : 'robot-2';
  const [isAddressFocused, setIsAddressFocused] = React.useState(false);
  const [activeSuggestion, setActiveSuggestion] = React.useState(-1);
  const visibleSuggestions = isAddressFocused ? suggestions : [];
  const [rowRoom, setRowRoom] = React.useState<number | null>(null);
  const watchRowRoom = React.useCallback((row: HTMLDivElement | null) => {
    if (!row) return undefined;
    const measure = () => {
      const room = measureRowRoom(row);
      if (room !== null) setRowRoom(room);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    setActiveSuggestion(-1);
  }, [address, isAddressFocused]);

  const addressInputRef = React.useRef<HTMLInputElement | null>(null);
  const submitAddress = (value: string) => {
    setIsAddressFocused(false);
    setActiveSuggestion(-1);
    addressInputRef.current?.blur();
    onSubmit(value);
  };

  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isIMECompositionEvent(event)) return;
    if (event.key === 'Enter' && activeSuggestion < 0) {
      event.preventDefault();
      submitAddress(address);
      return;
    }
    if (visibleSuggestions.length === 0) return;
    const key = getDropdownNavigationKey(event) ?? event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = key === 'ArrowDown' ? 1 : -1;
      const count = visibleSuggestions.length;
      setActiveSuggestion((current) => {
        const next = current + step;
        if (next < -1) return count - 1;
        if (next >= count) return -1;
        return next;
      });
      return;
    }
    if (event.key === 'Escape' && activeSuggestion >= 0) {
      event.preventDefault();
      setActiveSuggestion(-1);
      return;
    }
    if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault();
      const chosen = visibleSuggestions[activeSuggestion];
      if (chosen) submitAddress(chosen.url);
    }
  };

  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const shortcut = (id: string) => formatShortcutForDisplay(getEffectiveShortcutCombo(id, shortcutOverrides), '') || undefined;
  const shownAddress = isAddressFocused ? null : splitAddress(address);

  const rowActions: ToolbarGroup = [
    onToggleFollowAgent ? { id: 'follow-agent', icon: followAgentIconName, label: t(isFollowingAgent ? 'contextPanel.browser.server.followAgentOn' : 'contextPanel.browser.server.followAgentOff'), onSelect: onToggleFollowAgent, pressed: isFollowingAgent } : null,
    onToggleSound ? { id: 'sound', icon: soundIconName, label: t(isSoundOn ? isSoundUnavailable ? 'contextPanel.browser.server.sound.unavailable' : 'contextPanel.browser.server.sound.off' : 'contextPanel.browser.server.sound.on'), onSelect: onToggleSound, pressed: isSoundOn } : null,
    onToggleDeviceBar ? { id: 'device', icon: 'smartphone', label: t('contextPanel.browser.deviceToolbar'), onSelect: onToggleDeviceBar, pressed: isDeviceBarOpen } : null,
    onAnnotate ? { id: 'annotate', icon: 'markup', label: t('contextPanel.browser.annotate.toggle'), onSelect: onAnnotate, pressed: isAnnotating } : null,
    onToggleInspector ? { id: 'inspector', icon: 'terminal-box', label: t('contextPanel.browser.server.inspector.toggle'), onSelect: onToggleInspector, pressed: isInspectorOpen } : null,
  ];
  const menuActions: ToolbarGroup = [
    !menuItems ? { id: 'external', icon: 'external-link', label: t('contextPanel.browser.openExternal'), onSelect: onOpenExternal, disabled: !canOpenExternal } : null,
    onHardReload ? { id: 'hard-reload', icon: 'restart', label: t('contextPanel.browser.hardReload'), onSelect: onHardReload } : null,
    onZoomIn ? { id: 'zoom-in', icon: 'zoom-in', label: t('contextPanel.browser.zoomIn'), onSelect: onZoomIn, shortcut: shortcut('zoom_in') } : null,
    onZoomOut ? { id: 'zoom-out', icon: 'zoom-out', label: t('contextPanel.browser.zoomOut'), onSelect: onZoomOut, shortcut: shortcut('zoom_out') } : null,
    onOpenDevTools ? { id: 'devtools', icon: 'terminal-box', label: t('contextPanel.browser.devTools'), onSelect: onOpenDevTools } : null,
    onToggleDevTools ? { id: 'chrome-devtools', icon: 'code-sslash', label: t('contextPanel.browser.server.devTools.toggle'), onSelect: onToggleDevTools, pressed: isDevToolsOpen } : null,
    onClearCache ? { id: 'clear-cache', icon: 'database-2', label: t('contextPanel.browser.clearCache'), onSelect: onClearCache } : null,
    onClearCookies ? { id: 'clear-cookies', icon: 'delete-bin', label: t('contextPanel.browser.clearCookies'), onSelect: onClearCookies, destructive: true } : null,
    ...(menuItems?.flatMap((item) => item.kind === 'item' ? [item] : []) ?? []),
  ];
  const offeredRowActions = rowActions.filter((action): action is ToolbarAction => Boolean(action));
  const shownRowActions = rowRoom === null ? offeredRowActions : offeredRowActions.slice(0, rowRoom);
  const keyboardLabel = t('contextPanel.browser.keyboard.toggle');

  return (
    <div ref={watchRowRoom} className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
      <div data-browser-toolbar-nav="" className="flex shrink-0 items-center gap-0.5">
        {onHome ? <ToolbarTooltipButton icon="home" label={t('contextPanel.browser.devServers.title')} onClick={onHome} /> : null}
        <ToolbarTooltipButton icon="arrow-left" label={t('contextPanel.browser.back')} onClick={onBack} disabled={!canGoBack} />
        <ToolbarTooltipButton icon="arrow-right" label={t('contextPanel.browser.forward')} onClick={onForward} disabled={!canGoForward} />
        <ToolbarTooltipButton
          icon={isLoading ? 'close' : 'refresh'}
          label={isLoading ? t('contextPanel.browser.stop') : t('contextPanel.browser.reload')}
          onClick={onReload}
        />
      </div>
      <form
        className="relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress(address);
        }}
      >
        {addressMark ? (
          <span
            className="pointer-events-none absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            title={addressMark.label}
            aria-label={addressMark.label}
            role="img"
          >
            <Icon name={addressMark.icon} className="size-3.5" aria-hidden="true" />
          </span>
        ) : null}
        <input
          ref={addressInputRef}
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          onFocus={(event) => {
            setIsAddressFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => setIsAddressFocused(false)}
          onKeyDown={onAddressKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          role="combobox"
          aria-expanded={visibleSuggestions.length > 0}
          aria-controls="openchamber-browser-address-suggestions"
          className={cn(
            'oc-raised oc-field h-7 w-full rounded-full bg-[var(--surface-elevated)] px-3.5',
            addressMark && 'ps-8',
            zoomPercent !== 100 && 'pe-14',
            'typography-meta text-foreground outline-none',
            shownAddress && 'text-transparent',
          )}
          aria-label={t('contextPanel.browser.addressAria')}
        />
        {shownAddress ? (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 inset-s-0 flex min-w-0 items-center overflow-hidden px-3.5 typography-meta',
              'max-lg:[.mobile-pointer:not(.desktop-runtime)_&]:text-[16px]',
              addressMark && 'ps-8',
              zoomPercent !== 100 ? 'inset-e-14' : 'inset-e-0',
            )}
          >
            <span className="truncate">
              <span className="text-foreground">{shownAddress.host}</span>
              <span className="text-muted-foreground">{shownAddress.rest}</span>
            </span>
          </span>
        ) : null}
        {zoomPercent !== 100 && onZoomReset ? (
          <ButtonTooltip label={t('contextPanel.browser.zoomReset')} side="bottom" className="absolute inset-e-1 top-1/2 -translate-y-1/2">
            <button
              type="button"
              onClick={onZoomReset}
              aria-label={t('contextPanel.browser.zoomReset')}
              className="h-4.5 rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-1.5 typography-micro tabular-nums text-muted-foreground hover:text-foreground"
            >
              {zoomPercent}%
            </button>
          </ButtonTooltip>
        ) : null}
        <div id="openchamber-browser-address-suggestions">
          <BrowserAddressSuggestions
            entries={visibleSuggestions}
            activeIndex={activeSuggestion}
            onSelect={submitAddress}
            onForget={(url) => onForgetSuggestion?.(url)}
            onHighlight={setActiveSuggestion}
          />
        </div>
      </form>
      {onToggleKeyboard ? (
        <span data-browser-toolbar-pinned="" className="inline-flex shrink-0">
          <ToolbarTooltipButton
            icon="keyboard"
            label={keyboardLabel}
            pressed={isKeyboardOpen}
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onToggleKeyboard}
          />
        </span>
      ) : null}
      <ActionToolbar
        className="shrink-0"
        groups={[shownRowActions]}
        menuOnly={[...offeredRowActions.slice(shownRowActions.length), ...menuActions]}
      />
    </div>
  );
};
