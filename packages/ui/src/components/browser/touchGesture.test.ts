import { describe, expect, test } from 'bun:test';

import { beginTouch, endTouch, moveTouch, type TouchGesture, type TouchSample } from './touchGesture';

const drag = (samples: readonly TouchSample[]) => {
  let gesture: TouchGesture = beginTouch(1, samples[0]);
  const scrolled = { deltaX: 0, deltaY: 0 };
  for (const sample of samples.slice(1)) {
    const moved = moveTouch(gesture, sample);
    gesture = moved.gesture;
    scrolled.deltaX += moved.scroll.deltaX;
    scrolled.deltaY += moved.scroll.deltaY;
  }
  return { gesture, scrolled };
};

describe('a finger on the page picture', () => {
  test('a finger that stays put is a tap and scrolls nothing', () => {
    const { gesture, scrolled } = drag([{ x: 100, y: 100, time: 0 }, { x: 103, y: 104, time: 40 }]);
    expect(scrolled).toEqual({ deltaX: 0, deltaY: 0 });
    expect(endTouch(gesture, 60, 800)).toEqual({ kind: 'tap' });
  });

  test('dragging up scrolls the page down by the whole distance, the first steps included', () => {
    const { gesture, scrolled } = drag([
      { x: 100, y: 300, time: 0 },
      { x: 100, y: 295, time: 16 },
      { x: 100, y: 280, time: 32 },
      { x: 104, y: 200, time: 400 },
    ]);
    expect(scrolled).toEqual({ deltaX: -4, deltaY: 100 });
    expect(gesture.scrolling).toBe(true);
  });

  test('a drag that came to rest before the finger lifted does not glide', () => {
    const { gesture } = drag([{ x: 0, y: 300, time: 0 }, { x: 0, y: 200, time: 100 }, { x: 0, y: 199, time: 500 }]);
    expect(endTouch(gesture, 700, 800)).toEqual({ kind: 'scroll', flick: { deltaX: 0, deltaY: 0 } });
  });

  test('a flick keeps scrolling the way the finger went, up to the page height', () => {
    const { gesture } = drag([{ x: 0, y: 500, time: 0 }, { x: 0, y: 400, time: 20 }, { x: 0, y: 300, time: 40 }]);
    const ending = endTouch(gesture, 45, 800);
    expect(ending).toEqual({ kind: 'scroll', flick: { deltaX: 0, deltaY: 800 } });
    const slower = drag([{ x: 0, y: 500, time: 0 }, { x: 0, y: 480, time: 20 }, { x: 0, y: 460, time: 40 }]);
    expect(endTouch(slower.gesture, 45, 800)).toEqual({ kind: 'scroll', flick: { deltaX: 0, deltaY: 320 } });
  });
});
