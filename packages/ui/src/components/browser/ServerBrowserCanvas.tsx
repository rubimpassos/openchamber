import React from 'react';

import { SURFACE_INPUT_BATCH_MAX, type SurfaceInputEvent, type SurfaceModifiers } from '@openchamber/sdk';

import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { SurfaceAudioPlayer } from '@/lib/guests/surface-audio';
import { clearSurfaceViewerId, setSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { SurfaceClient, type SurfaceConnectionState, type SurfaceControlState, type SurfaceFrame } from '@/lib/guests/surface-client';
import { cn } from '@/lib/utils';

import { RemoteTypingField, type RemoteTypingHandle } from './RemoteTypingField';
import { beginTouch, endTouch, moveTouch, type ScrollDelta, type TouchGesture } from './touchGesture';

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

const NO_MODIFIERS: SurfaceModifiers = { alt: false, ctrl: false, meta: false, shift: false };

const isCopyChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c';
const isPasteChord = (event: React.KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'v';

export type ServerBrowserCanvasHandle = {
  readonly release: () => void;
  /** Call from the click that turns sound on: browsers start audio only in answer to the person. */
  readonly setAudio: (enabled: boolean) => void;
  readonly toggleKeyboard: () => void;
};

type ServerBrowserTyping = {
  readonly targetKey: string;
  readonly pageEpoch: string;
  readonly onOpenChange: (open: boolean) => void;
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
  /** `false` once the extension says it has no sound to send. */
  onAudioState?: (available: boolean) => void;
  typing?: ServerBrowserTyping;
}>(({ guestId, onViewer, onControl, onConnection, onFocusChange, onAudioState, typing }, forwardedRef) => {
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
  const playerRef = React.useRef<SurfaceAudioPlayer | null>(null);
  const onAudioStateRef = React.useRef(onAudioState);
  onAudioStateRef.current = onAudioState;
  const typingRef = React.useRef<RemoteTypingHandle | null>(null);
  const touchRef = React.useRef<TouchGesture | null>(null);

  const [hasFrame, setHasFrame] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  React.useImperativeHandle(forwardedRef, () => ({
    release: () => clientRef.current?.release(),
    setAudio: (enabled) => {
      if (enabled) {
        playerRef.current ??= new SurfaceAudioPlayer();
        playerRef.current.resume();
      } else {
        // Closing the output silences what was already scheduled at once.
        playerRef.current?.dispose();
        playerRef.current = null;
      }
      clientRef.current?.setAudio(enabled);
    },
    toggleKeyboard: () => typingRef.current?.toggle(),
  }), []);

  React.useEffect(() => () => {
    playerRef.current?.dispose();
    playerRef.current = null;
  }, []);

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
      onAudio: (batch) => playerRef.current?.play(batch),
      onAudioState: (available) => onAudioStateRef.current?.(available),
      onError: () => typingRef.current?.clear(),
    });
    clientRef.current = client;
    // Sound that was on stays on for this extension's new connection.
    if (playerRef.current) client.setAudio(true);
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
      for (let sent = 0; sent < events.length; sent += SURFACE_INPUT_BATCH_MAX) {
        clientRef.current?.sendInput(events.slice(sent, sent + SURFACE_INPUT_BATCH_MAX));
      }
      if (clipboardAfterFlushRef.current) {
        clipboardAfterFlushRef.current = false;
        clipboardRequestsRef.current += 1;
        clientRef.current?.requestClipboard(`copy-${clipboardRequestsRef.current}`);
      }
    });
  }, []);

  const frameScale = React.useCallback((): number => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    const width = canvas?.getBoundingClientRect().width ?? 0;
    return size && width > 0 ? size.width / width : 1;
  }, []);

  const framePoint = React.useCallback((position: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const size = frameSizeRef.current;
    if (!canvas || !size) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((position.clientX - rect.left) / rect.width) * size.width;
    const y = ((position.clientY - rect.top) / rect.height) * size.height;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const queueScroll = (gesture: TouchGesture, scroll: ScrollDelta) => {
    if (scroll.deltaX === 0 && scroll.deltaY === 0) return;
    const anchor = framePoint({ clientX: gesture.start.x, clientY: gesture.start.y });
    if (!anchor) return;
    const scale = frameScale();
    const deltaX = scroll.deltaX * scale;
    const deltaY = scroll.deltaY * scale;
    const waiting = batchRef.current.at(-1);
    if (waiting?.type === 'wheel' && waiting.x === anchor.x && waiting.y === anchor.y) {
      batchRef.current[batchRef.current.length - 1] = { ...waiting, deltaX: waiting.deltaX + deltaX, deltaY: waiting.deltaY + deltaY };
      return;
    }
    queue({ type: 'wheel', x: anchor.x, y: anchor.y, deltaX, deltaY, modifiers: NO_MODIFIERS });
  };

  const takePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!typingRef.current?.isOpen()) containerRef.current?.focus();
    typingRef.current?.clear();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onTouch = (action: 'down' | 'up' | 'move' | 'cancel', event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const sample = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (action === 'down') {
      touchRef.current = touchRef.current ? null : beginTouch(event.pointerId, sample);
      takePointer(event);
      return;
    }
    const gesture = touchRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (action === 'move') {
      const moved = moveTouch(gesture, sample);
      touchRef.current = moved.gesture;
      queueScroll(moved.gesture, moved.scroll);
      return;
    }
    touchRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (action === 'cancel') return;
    const ending = endTouch(gesture, event.timeStamp, frameSizeRef.current?.height ?? 0);
    if (ending.kind === 'scroll') {
      queueScroll(gesture, ending.flick);
      return;
    }
    const point = framePoint(event);
    if (!point) return;
    const modifiers = modifiersOf(event);
    queue({ type: 'pointer', action: 'down', x: point.x, y: point.y, button: 0, buttons: 1, modifiers });
    queue({ type: 'pointer', action: 'up', x: point.x, y: point.y, button: 0, buttons: 0, modifiers });
  };

  const onPointer = (action: 'down' | 'up' | 'move' | 'cancel') => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!hasFrame) return;
    if (event.pointerType === 'touch') {
      onTouch(action, event);
      return;
    }
    if (action === 'cancel') return;
    if (action === 'move' && event.buttons === 0 && !(controlRef.current.controller === 'user' && controlRef.current.mine)) return;
    const point = framePoint(event);
    if (!point) return;
    if (action === 'down') {
      takePointer(event);
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

  const forwardKey = (action: 'down' | 'up', event: React.KeyboardEvent<HTMLElement>) => {
    if (!hasFrame) return;
    if (isPasteChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'down' && isCopyChord(event)) clipboardAfterFlushRef.current = true;
    queue({ type: 'key', action, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiersOf(event) });
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!hasFrame) return;
    const text = event.clipboardData.getData('text/plain');
    event.preventDefault();
    typingRef.current?.clear();
    if (text) queue({ type: 'text', text });
  };

  const attachCanvas = React.useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (!canvas) return undefined;
    const keepFromDrawerSwipe = (event: TouchEvent) => event.stopPropagation();
    canvas.addEventListener('touchstart', keepFromDrawerSwipe, { passive: true });
    return () => {
      canvas.removeEventListener('touchstart', keepFromDrawerSwipe);
      canvasRef.current = null;
    };
  }, []);

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
      onKeyDown={(event) => forwardKey('down', event)}
      onKeyUp={(event) => forwardKey('up', event)}
      onPaste={onPaste}
      data-focused={focused || undefined}
    >
      <canvas
        ref={attachCanvas}
        className={cn(
          'shrink-0 touch-none',
          hasFrame ? 'block' : 'hidden',
          controlRef.current.controller === 'user' && !controlRef.current.mine ? 'cursor-not-allowed' : 'cursor-default',
        )}
        onPointerDown={onPointer('down')}
        onPointerMove={onPointer('move')}
        onPointerUp={onPointer('up')}
        onPointerCancel={onPointer('cancel')}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      {typing ? (
        <RemoteTypingField
          key={typing.targetKey}
          ref={typingRef}
          pageEpoch={typing.pageEpoch}
          onType={(events) => { for (const event of events) queue(event); }}
          onKey={forwardKey}
          onOpenChange={typing.onOpenChange}
        />
      ) : null}
    </div>
  );
});
ServerBrowserCanvas.displayName = 'ServerBrowserCanvas';
