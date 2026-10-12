import { expect, test } from 'bun:test';

import { placeGuestTooltip } from './tooltip.ts';

const frame = (zoom: number) => ({
  getBoundingClientRect: () => ({ left: 100, top: 50, right: 100 + 200 * zoom, bottom: 50 + 300 * zoom, width: 200 * zoom, height: 300 * zoom }),
  clientWidth: 200,
  clientHeight: 300,
});

test('a guest anchor maps to page pixels through the frame zoom; one outside the frame shows nothing', () => {
  const request = { text: 'Full', anchor: { x: 10, y: 20, width: 100, height: 28 } };
  expect(placeGuestTooltip(request, frame(1.25))?.rect).toEqual({ left: 112.5, top: 75, width: 125, height: 35 });
  expect(placeGuestTooltip({ ...request, anchor: { x: 10, y: 400, width: 100, height: 28 } }, frame(1))).toBeNull();
});
