import type { HostClient } from '../host.ts';
import type { GuestPopoverSide } from '../popover.ts';

export type TooltipOptions = {
  host: Pick<HostClient, 'showTooltip' | 'hideTooltip'>;
  /** The tooltip text, read when it opens. Empty shows nothing. */
  text: string | (() => string);
  side?: GuestPopoverSide;
  /** Hover delay before it opens, in ms. */
  delay?: number;
};

export type TooltipHandle = { update: (text: string | (() => string)) => void; dispose: () => void };

/**
 * Shows `text` in the host's tooltip while the pointer rests on `element` (or
 * it has keyboard focus), so an extension's tooltips look like the app's
 * instead of the browser's. On a host without tooltips it falls back to the
 * native `title`.
 */
export const mountTooltip = (element: HTMLElement, options: TooltipOptions): TooltipHandle => {
  let text = options.text;
  const delay = options.delay ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  let native = false;
  const read = (): string => (typeof text === 'function' ? text() : text);

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const hide = (): void => {
    clear();
    if (!shown) return;
    shown = false;
    void options.host.hideTooltip().catch(() => undefined);
  };
  const show = (): void => {
    const value = read();
    const rect = element.getBoundingClientRect();
    if (!value || !element.isConnected || rect.width <= 0 || rect.height <= 0) return;
    shown = true;
    options.host.showTooltip({
      text: value,
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      ...(options.side ? { side: options.side } : {}),
    }).catch(() => {
      shown = false;
      native = true;
      element.title = read();
    });
  };
  const schedule = (): void => {
    if (native) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      show();
    }, delay);
  };
  const onFocus = (): void => {
    if (element.matches(':focus-visible')) schedule();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hide();
  };
  const scrollTarget = element.ownerDocument;

  element.addEventListener('pointerenter', schedule);
  element.addEventListener('pointerleave', hide);
  element.addEventListener('pointerdown', hide);
  element.addEventListener('focus', onFocus);
  element.addEventListener('blur', hide);
  element.addEventListener('keydown', onKey);
  // A wheel over a frame that cannot scroll moves the host page instead.
  scrollTarget.addEventListener('scroll', hide, true);
  scrollTarget.addEventListener('wheel', hide, { capture: true, passive: true });

  return {
    update: (next) => {
      text = next;
      if (native) element.title = read();
    },
    dispose: () => {
      hide();
      element.removeEventListener('pointerenter', schedule);
      element.removeEventListener('pointerleave', hide);
      element.removeEventListener('pointerdown', hide);
      element.removeEventListener('focus', onFocus);
      element.removeEventListener('blur', hide);
      element.removeEventListener('keydown', onKey);
      scrollTarget.removeEventListener('scroll', hide, true);
      scrollTarget.removeEventListener('wheel', hide, { capture: true });
    },
  };
};
