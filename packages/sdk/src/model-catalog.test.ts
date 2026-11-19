import { expect, test } from 'bun:test';
import { guestMessageSchema, hostMessageSchema } from './protocol.ts';

const request = { channel: 'openchamber.sdk', v: 1, type: 'listModels', id: 'models-1' } as const;

test('admits listModels when the request has no payload', () => {
  // Given / When
  const parsed = guestMessageSchema.safeParse(request);
  // Then
  expect(parsed.success && parsed.data).toEqual(request);
});

test.each([{}, { directory: '/other' }, null])('refuses listModels when a payload is supplied: %j', (payload: unknown) => {
  // Given / When
  const parsed = guestMessageSchema.safeParse({ ...request, payload });
  // Then
  expect(parsed.success).toBe(false);
});

test('preserves catalog entries when a model list crosses the result wire', () => {
  // Given
  const reply = { channel: 'openchamber.sdk', v: 1, type: 'result', id: request.id, ok: true,
    payload: [{ id: 'provider/model-fast', name: 'Model Fast', variants: ['low', 'high'] }] };
  // When
  const parsed = hostMessageSchema.safeParse(reply);
  // Then
  expect(parsed.success && parsed.data).toEqual(reply);
});

test('refuses a model list result when variants are not IDs', () => {
  // Given
  const reply = { channel: 'openchamber.sdk', v: 1, type: 'result', id: request.id, ok: true,
    payload: [{ id: 'provider/model', name: 'Model', variants: [{ id: 'high', settings: {} }] }] };
  // When
  const parsed = hostMessageSchema.safeParse(reply);
  // Then
  expect(parsed.success).toBe(false);
});
