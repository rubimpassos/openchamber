import { describe, expect, test } from 'bun:test';

import { nextAudioSlot, splitAudioPackets } from './surface-audio';

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

describe('surface audio packets', () => {
  test('splits a batch into its length-prefixed packets', () => {
    const packets = splitAudioPackets(bytes(0, 2, 7, 8, 0, 1, 9));
    expect(packets?.map((packet) => [...packet])).toEqual([[7, 8], [9]]);
  });

  test('refuses a batch whose lengths do not add up', () => {
    expect(splitAudioPackets(bytes(0, 3, 7, 8))).toBeNull();
    expect(splitAudioPackets(bytes(0, 0))).toBeNull();
    expect(splitAudioPackets(bytes(0))).toBeNull();
  });
});

describe('surface audio playback time', () => {
  test('plays each buffer right after the previous one while the stream keeps up', () => {
    expect(nextAudioSlot(10, 10.2)).toEqual({ start: 10.2, restart: false });
  });

  test('starts a little ahead of now after a gap', () => {
    expect(nextAudioSlot(10, 9.5)).toEqual({ start: 10.12, restart: false });
  });

  test('drops what is queued and starts again near now when a burst queued too much', () => {
    // A stall followed by a burst: the next buffer would play over a second late.
    const slot = nextAudioSlot(10, 11.2);
    expect(slot.restart).toBe(true);
    expect(Math.abs(slot.start - 10.12) < 1e-9).toBe(true);
  });
});
