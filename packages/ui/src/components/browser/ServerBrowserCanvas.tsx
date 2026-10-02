import React from 'react';

import type { SurfaceInputEvent, SurfaceModifiers } from '@openchamber/sdk';

import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { clearSurfaceViewerId, setSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { SurfaceClient, type SurfaceConnectionState, type SurfaceControlState, type SurfaceFrame } from '@/lib/guests/surface-client';
import { cn } from '@/lib/utils';

/**
 * The picture and input half of the server browser panel: the same canvas,
 * pointer/keyboard/paste forwarding, and `SurfaceClient` wire protocol the
 * shared-surface dock panel uses (`GuestSurfacePane`), just without that
 * panel's own header — the native browser toolbar sits above this instead.
 */

const RESIZE_DEBOUNCE_MS = 250;

const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SurfaceModifiers => ({
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

const isCopyChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c';
const isPasteChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';

export type ServerBrowserCanvasHandle = {
  readonly release: () => void;
};

/**
 * Lays the canvas out at the page's CSS size, shrunk to fit the panel when the
 * page is larger (a fixed viewport), never stretched past it.
 */
const fitCanvas = (canvas: HTMLCanvasElement, container: HTMLElement | null, width: number, height: number) => {
  if (width <= 0 || height <= 0) return;
  const boxWidth = container?.clientWidth || width;
  const boxHeight = container?.clientHeight || height;
  const fit = Math.min(1, boxWidth / width, boxHeight / height);
  canvas.style.width = `${Math.floor(width * fit)}px`;
  canvas.style.height = `${Math.floor(height * fit)}px`;
};

export const ServerBrowserCanvas = React.forwardRef<ServerBrowserCanvasHandle, {
  guestId: string;
  onViewer: (viewerId: string | undefined) => void;
  onControl: (control: SurfaceControlState) => void;
  onConnection: (connection: SurfaceConnectionState) => void;
  onFocusChange?: (focused: boolean) => void;
}>(({ guestId, onViewer, onControl, onConnection, onFocusChange }, forwardedRef) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<SurfaceClient | null>(null);
  const frameSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  const batchRef = React.useRef<SurfaceInputEvent[]>([]);
  const flushRef = React.useRef<number | null>(null);
  const clipboardRequestsRef = React.useRef(0);
  const clipboardAfterFlushRef = React.useRef(false);
  const controlRef = React.useRef<SurfaceControlState>({ controller: 'none', mine: false });

  const [hasFrame, setHasFrame] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  React.useImperativeHandle(forwardedRef, () => ({
    release: () => clientRef.current?.release(),
  }), []);

  const drawFrame = React.useCallback(async (frame: SurfaceFrame) => {
    const canvas = canvasRef.current;
    const client = clientRef.current;
    if (!canvas || !client) return;
    try {
      const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: frame.mime }));
      // The page renders at this screen's density, so the picture has more
      // pixels than the frame's CSS size. Back the canvas with every one of
      // them and lay it out at the CSS size; drawing it at CSS size would
      // throw the extra sharpness away.
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      fitCanvas(canvas, containerRef.current, frame.width, frame.height);
      const context = canvas.getContext('2d');
      if (context) context.imageSmoothingQuality = 'high';
      context?.drawImage(bitmap, 0, 0);
      bitmap.close();
      // Pointer coordinates go to the page in CSS pixels.
      frameSizeRef.current = { width: frame.width, height: frame.height };
      setHasFrame(true);
    } catch {
      // An undecodable frame is skipped; the next one replaces it.
    } finally {
      client.ack(frame.seq);
    }
  }, []);

  React.useEffect(() => {
    let viewerId: string | null = null;
    const client = new SurfaceClient(guestId, {
      onViewer: (id) => {
        if (viewerId) clearSurfaceViewerId(guestId, viewerId);
        viewerId = id;
        setSurfaceViewerId(guestId, id);
        onViewer(id);
      },
      onFrame: (frame) => { void drawFrame(frame); },
      onControl: (next) => { controlRef.current = next; onControl(next); },
      onConnection,
      onClipboard: (_id, text) => { void copyTextToClipboard(text); },
    });
    clientRef.current = client;
    client.start();
    return () => {
      if (viewerId) clearSurfaceViewerId(guestId, viewerId);
      onViewer(undefined);
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      if (flushRef.current !== null) cancelAnimationFrame(flushRef.current);
      flushRef.current = null;
      batchRef.current = [];
      frameSizeRef.current = null;
      setHasFrame(false);
    };
    // `onViewer`/`onControl`/`onConnection` are identity-stable callbacks from
    // the parent; re-subscribing on every render would tear the socket down
    // for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guestId, drawFrame]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const size = frameSizeRef.current;
        if (canvasRef.current && size) fitCanvas(canvasRef.current, container, size.width, size.height);
        const scale = window.devicePixelRatio || 1;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        if (w > 0 && h > 0) clientRef.current?.resize(w, h);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const queue = React.useCallback((event: SurfaceInputEvent) => {
    batchRef.current.push(event);
    if (flushRef.current !== null) return;
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null;
      const events = batchRef.current;
      batchRef.current = [];
      clientRef.current?.sendInput(events);
      if (clipboardAfterFlushRef.current) {
        clipboardAfterFlushRef.current = false;
        clipboardRequestsRef.current += 1;
        clientRef.current?.requestClipboard(`copy-${clipboardRequestsRef.current}`);
      }
    });
  }, []);

  const framePoint = React.useCallback((event: React.PointerEvent | React.WheelEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * size.width;
    const y = ((event.clientY - rect.top) / rect.height) * size.height;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const onPointer = (action: 'down' | 'up' | 'move') => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    if (action === 'move' && event.buttons === 0 && !(controlRef.current.controller === 'user' && controlRef.current.mine)) return;
    const point = framePoint(event);
    if (!point) return;
    if (action === 'down') {
      containerRef.current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (action === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    queue({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: action === 'move' ? -1 : event.button,
      buttons: event.buttons,
      modifiers: modifiersOf(event),
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    const point = framePoint(event);
    if (!point) return;
    event.preventDefault();
    queue({ type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
  };

  const onKey = (action: 'down' | 'up') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    if (isPasteChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'down' && isCopyChord(event)) clipboardAfterFlushRef.current = true;
    queue({ type: 'key', action, key: event.key, code: event.code, modifiers: modifiersOf(event) });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    if (text) queue({ type: 'text', text });
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label={t('contextPanel.browser.frameTitle')}
      data-terminal-owner={`surface:${guestId}`}
      className={cn(
        'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--surface-muted)] outline-none',
      )}
      onFocus={() => { setFocused(true); onFocusChange?.(true); }}
      onBlur={() => { setFocused(false); onFocusChange?.(false); }}
      onKeyDown={onKey('down')}
      onKeyUp={onKey('up')}
      onPaste={onPaste}
      data-focused={focused || undefined}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'shrink-0',
          hasFrame ? 'block' : 'hidden',
          controlRef.current.controller === 'user' && !controlRef.current.mine ? 'cursor-not-allowed' : 'cursor-default',
        )}
        onPointerDown={onPointer('down')}
        onPointerMove={onPointer('move')}
        onPointerUp={onPointer('up')}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>
  );
});
ServerBrowserCanvas.displayName = 'ServerBrowserCanvas';
