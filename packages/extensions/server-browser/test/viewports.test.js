import assert from 'node:assert/strict';
import test from 'node:test';
import { cssSize, deviceScale, MAX_DEVICE_SCALE, viewportSummary } from '../src/viewports.js';

test('converts the panel from device pixels to bounded CSS pixels', () => {
  assert.deepEqual(cssSize({ width: 1400, height: 1001 }, 2), { width: 700, height: 501 });
  assert.deepEqual(cssSize({ width: 1500, height: 900 }, 1.5), { width: 1000, height: 600 });
  assert.deepEqual(cssSize({ width: 20_000, height: 1 }, 1), { width: 3840, height: 1 });
});

test('names preset sizes and reports anything else as custom', () => {
  assert.deepEqual(viewportSummary({ width: 390, height: 844, mobile: true }), { mode: 'mobile', width: 390, height: 844 });
  assert.deepEqual(viewportSummary({ width: 700, height: 500, mobile: false }), { mode: 'custom', width: 700, height: 500 });
});

test('renders at the viewer density, capped by the scale limit and the frame area', () => {
  assert.equal(deviceScale({ width: 800, height: 600 }, 1.25), 1.25);
  assert.equal(deviceScale({ width: 800, height: 600 }, 3), MAX_DEVICE_SCALE);
  assert.equal(deviceScale({ width: 800, height: 600 }, 0.5), 1);
  assert.equal(deviceScale({ width: 800, height: 600 }, undefined), 1);
  // A huge panel keeps its frames under the pixel budget instead of doubling.
  assert.ok(deviceScale({ width: 3840, height: 2160 }, 2) < 2);
});
