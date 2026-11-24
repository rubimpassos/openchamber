import React from 'react';
import { HostRequestError, type ModelPickRequest, type ModelPickResult } from '@openchamber/sdk';
import { guestAnchorRect, guestPopoverOwnerBlocked, watchGuestPopoverOwner } from '@/lib/guests/popovers';
import { useConfigStore } from '@/stores/useConfigStore';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

export type GuestModelPickerOpening = {
  readonly id: number;
  readonly request: ModelPickRequest;
  readonly frame: HTMLIFrameElement;
  readonly directory: string | undefined;
  readonly anchor: DOMRect;
  readonly resolve: (result: ModelPickResult) => void;
};

export const useGuestModelPicker = (owner: { readonly directory: string | undefined; readonly panelOpen: boolean }) => {
  const [opening, setOpening] = React.useState<GuestModelPickerOpening | null>(null);
  const current = React.useRef<GuestModelPickerOpening | null>(null);
  const nextId = React.useRef(0);
  const finish = React.useCallback((result: ModelPickResult) => {
    const pending = current.current;
    current.current = null;
    setOpening(null);
    pending?.resolve(result);
  }, []);
  const dismiss = React.useCallback(() => finish({ picked: false }), [finish]);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const open = React.useCallback((request: ModelPickRequest, owner: { frame: HTMLIFrameElement; directory: string | undefined }) => {
    const { frame, directory } = owner;
    const bounds = frame.getBoundingClientRect();
    const anchor = guestAnchorRect({ anchor: request.anchor,
      frame: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        clientWidth: frame.clientWidth, clientHeight: frame.clientHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!anchor || guestPopoverOwnerBlocked(frame, current.current?.frame === frame)) {
      throw new HostRequestError('HOST_REJECTED', 'The model picker anchor is not visible.');
    }
    dismiss();
    return new Promise<ModelPickResult>((resolve) => {
      nextId.current += 1;
      const next = { id: nextId.current, request, frame, directory, anchor: DOMRect.fromRect({ x: anchor.left, y: anchor.top,
        width: anchor.width, height: anchor.height }), resolve };
      current.current = next;
      setOpening(next);
    });
  }, [dismiss]);
  React.useEffect(() => dismiss(), [owner.directory, owner.panelOpen, dismiss]);
  React.useEffect(() => {
    if (opening?.directory) void loadProviders({ directory: opening.directory });
  }, [opening, loadProviders]);
  React.useEffect(() => {
    if (!opening) return;
    const { frame } = opening;
    if (guestPopoverOwnerBlocked(frame, true)) { dismiss(); return; }
    const stop = watchGuestPopoverOwner(frame, dismiss, true);
    const resize = new ResizeObserver(() => {
      if (frame.getClientRects().length === 0 || frame.clientWidth === 0 || frame.clientHeight === 0) dismiss();
    });
    resize.observe(frame);
    const blur = () => { if (document.activeElement === frame) dismiss(); };
    const press = (event: PointerEvent) => {
      if (!event.composedPath().some((node) => node instanceof Element && node.hasAttribute('data-guest-popover-overlay'))) dismiss();
    };
    window.addEventListener('blur', blur);
    if (!isMobileSurfaceRuntime()) document.addEventListener('pointerdown', press, true);
    return () => {
      stop();
      resize.disconnect();
      window.removeEventListener('blur', blur);
      document.removeEventListener('pointerdown', press, true);
    };
  }, [opening, dismiss]);
  return { opening, open, finish, dismiss };
};
