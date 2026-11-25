export type TouchSample = {
  readonly x: number;
  readonly y: number;
  readonly time: number;
};

export type TouchGesture = {
  readonly pointerId: number;
  readonly start: TouchSample;
  readonly last: TouchSample;
  readonly earlier: TouchSample;
  readonly scrolling: boolean;
};

export type ScrollDelta = {
  readonly deltaX: number;
  readonly deltaY: number;
};

const TAP_SLOP_PX = 8;
const VELOCITY_WINDOW_MS = 90;
const FLICK_MIN_SPEED = 0.3;
const FLICK_GLIDE_MS = 320;
const NO_SCROLL: ScrollDelta = { deltaX: 0, deltaY: 0 };

export const beginTouch = (pointerId: number, sample: TouchSample): TouchGesture => ({
  pointerId,
  start: sample,
  last: sample,
  earlier: sample,
  scrolling: false,
});

type TouchMove = {
  readonly gesture: TouchGesture;
  readonly scroll: ScrollDelta;
};

export const moveTouch = (gesture: TouchGesture, sample: TouchSample): TouchMove => {
  const travelled = Math.hypot(sample.x - gesture.start.x, sample.y - gesture.start.y);
  const scrolling = gesture.scrolling || travelled > TAP_SLOP_PX;
  const from = gesture.scrolling ? gesture.last : gesture.start;
  const earlier = sample.time - gesture.earlier.time > VELOCITY_WINDOW_MS ? gesture.last : gesture.earlier;
  return {
    gesture: { ...gesture, last: sample, earlier, scrolling },
    scroll: scrolling ? { deltaX: from.x - sample.x, deltaY: from.y - sample.y } : NO_SCROLL,
  };
};

type TouchEnding =
  | { readonly kind: 'tap' }
  | { readonly kind: 'scroll'; readonly flick: ScrollDelta };

export const endTouch = (gesture: TouchGesture, time: number, maxGlide: number): TouchEnding => {
  if (!gesture.scrolling) return { kind: 'tap' };
  const elapsed = gesture.last.time - gesture.earlier.time;
  if (elapsed <= 0 || time - gesture.last.time > VELOCITY_WINDOW_MS) return { kind: 'scroll', flick: NO_SCROLL };
  const speedX = (gesture.earlier.x - gesture.last.x) / elapsed;
  const speedY = (gesture.earlier.y - gesture.last.y) / elapsed;
  if (Math.hypot(speedX, speedY) < FLICK_MIN_SPEED) return { kind: 'scroll', flick: NO_SCROLL };
  const glide = (speed: number) => Math.max(-maxGlide, Math.min(maxGlide, speed * FLICK_GLIDE_MS));
  return { kind: 'scroll', flick: { deltaX: glide(speedX), deltaY: glide(speedY) } };
};
