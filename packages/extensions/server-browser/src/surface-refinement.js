import { SURFACE_FRAME_MAX_BYTES } from '@openchamber/sdk';
import { deviceScale } from './viewports.js';

const REFINE_QUALITY = 88;
const REFINE_AFTER_MS = 180;
const REFINE_ECHO_MS = 120;

// Motion stays at CSS size; a settled page gets one image at viewer density.
// Frames, input and navigation invalidate a screenshot already in flight.
export const createSurfaceRefinement = (runtime, page, publish) => {
  let timer = null;
  let changes = 0;
  let refinedAt = 0;
  let disposed = false;
  let documentCaptures = new AbortController();
  let mainFrameId = page.targetId;
  // runtime.isLoading describes the inspected tab, never the DevTools frontend.
  let loading = !page.devtools && runtime.isLoading;
  const isLoading = () => loading || (!page.devtools && runtime.isLoading);
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  const refine = async (mark) => {
    const viewport = runtime.surfaceViewport;
    if (disposed || isLoading() || !viewport || deviceScale(viewport, viewport.scale) <= 1) return;
    // A page paused on a dialog takes no screenshot until it is answered.
    if (runtime.dialogOpen(page.targetId)) return;
    let capture;
    try {
      capture = await page.cdp.sendSession(page.sessionId, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: REFINE_QUALITY,
        optimizeForSpeed: true,
      }, documentCaptures.signal);
    } catch {
      return;
    }
    if (disposed) return;
    if (changes !== mark) {
      schedule();
      return;
    }
    const bytes = Buffer.from(String(capture.data ?? ''), 'base64');
    if (bytes.length === 0 || bytes.length > SURFACE_FRAME_MAX_BYTES) return;
    refinedAt = Date.now();
    publish({
      bytes,
      mime: 'image/jpeg',
      width: viewport.width,
      height: viewport.height,
      title: runtime.title,
    });
  };
  const schedule = () => {
    cancel();
    if (disposed || isLoading()) return;
    const mark = changes;
    timer = setTimeout(() => {
      timer = null;
      void refine(mark);
    }, REFINE_AFTER_MS);
    timer.unref?.();
  };
  const unsubscribe = page.cdp.onEvent((event) => {
    if (event.sessionId !== page.sessionId) return;
    switch (event.method) {
      case 'Page.frameNavigated':
        if (event.params.frame?.id && !event.params.frame.parentId) mainFrameId = event.params.frame.id;
        return;
      case 'Page.frameStartedLoading':
        if (event.params.frameId !== mainFrameId) return;
        loading = true;
        documentCaptures.abort();
        documentCaptures = new AbortController();
        changes += 1;
        refinedAt = 0;
        cancel();
        return;
      case 'Page.frameStoppedLoading':
        if (event.params.frameId !== mainFrameId) return;
        loading = false;
        schedule();
        return;
      default:
        return;
    }
  });
  return {
    get echo() { return Date.now() - refinedAt < REFINE_ECHO_MS; },
    motion() {
      changes += 1;
      schedule();
    },
    input() {
      changes += 1;
      if (timer) schedule();
    },
    dispose() {
      disposed = true;
      documentCaptures.abort();
      cancel();
      unsubscribe();
    },
  };
};
