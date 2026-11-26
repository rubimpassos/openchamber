import { describe, expect, test } from 'bun:test';

import { readSurfaceControlNotice, readSurfaceInputBatch } from './service-surface.ts';
import { surfaceHostMessageSchema, surfaceViewerMessageSchema } from './service-surface-schemas.ts';

describe('surface presentation wire', () => {
  const frame = { type: 'frame', seq: 7, width: 320, height: 200, mime: 'image/png', bytes: 3, agentActive: false };

  test('preserves optional view identity, explicit presentation, and the host confirmation', () => {
    expect(surfaceHostMessageSchema.parse({ ...frame, viewId: 'view-B' })).toEqual({ ...frame, viewId: 'view-B' });
    expect(surfaceHostMessageSchema.parse(frame)).toEqual(frame);
    for (const presented of [true, false]) {
      expect(surfaceViewerMessageSchema.parse({ type: 'ack', seq: 7, presented })).toEqual({ type: 'ack', seq: 7, presented });
    }
    expect(surfaceViewerMessageSchema.parse({ type: 'ack', seq: 7 })).toEqual({ type: 'ack', seq: 7 });
    const confirmed = { type: 'presented', seq: 7, viewId: 'view-B' };
    expect(surfaceHostMessageSchema.parse(confirmed)).toEqual(confirmed);
  });

  test.each(['', 'x'.repeat(129), 'view\nB', 'view\u00e9'])('refuses an invalid frame or confirmation identity %j', (viewId) => {
    expect(surfaceHostMessageSchema.safeParse({ ...frame, viewId }).success).toBe(false);
    expect(surfaceHostMessageSchema.safeParse({ type: 'presented', seq: 7, viewId }).success).toBe(false);
  });
});

describe('readSurfaceInputBatch', () => {
  const modifiers = { alt: false, ctrl: false, meta: false, shift: false };
  const keyBatch = (extra: { keyCode?: number | string }) => JSON.stringify({ events: [{ type: 'key', action: 'down', key: '.', code: 'Period', modifiers, ...extra }] });

  test('keeps the keyCode the viewer browser reported', () => {
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 190 }))?.events).toEqual([{ type: 'key', action: 'down', key: '.', code: 'Period', keyCode: 190, modifiers }]);
  });

  test('reads key events from hosts that send no keyCode', () => {
    expect(readSurfaceInputBatch(keyBatch({}))?.events).toEqual([{ type: 'key', action: 'down', key: '.', code: 'Period', modifiers }]);
  });

  test('refuses a keyCode outside 0 to 255', () => {
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 256 }))).toBeNull();
    expect(readSurfaceInputBatch(keyBatch({ keyCode: 1.5 }))).toBeNull();
    expect(readSurfaceInputBatch(keyBatch({ keyCode: '190' }))).toBeNull();
  });
});

describe('readSurfaceControlNotice', () => {
  test('keeps the controlling viewer for a user controller', () => {
    expect(readSurfaceControlNotice('{"controller":"user","viewer":"viewer-1"}')).toEqual({ controller: 'user', viewer: 'viewer-1' });
  });

  test('reads notices from hosts that send no viewer', () => {
    expect(readSurfaceControlNotice('{"controller":"user"}')).toEqual({ controller: 'user' });
  });

  test('drops a viewer attached to a non-user controller', () => {
    expect(readSurfaceControlNotice('{"controller":"agent","viewer":"viewer-1"}')).toEqual({ controller: 'agent' });
  });

  test('refuses an unknown controller', () => {
    expect(readSurfaceControlNotice('{"controller":"robot"}')).toBeNull();
  });
});
