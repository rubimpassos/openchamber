import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { parseGuestMessage } from './protocol.ts';
import { guestStatusSummarySchema } from './status-control-schemas.ts';
import { isGuestStatusSummary, type GuestStatusSummaryItem } from './status-summary.ts';

const items: GuestStatusSummaryItem[] = [
  { text: '2/5', icon: 'list-check-2', label: '2 of 5 todos done' },
  { text: '1', icon: 'loader-4', label: '1 background task running', tone: 'info' },
];

describe('status summary', () => {
  test('accepts up to four short items in the guard, the schema and the wire message', () => {
    expect(isGuestStatusSummary(items)).toBe(true);
    expect(isGuestStatusSummary([])).toBe(true);
    expect(guestStatusSummarySchema.parse(items)).toEqual(items);
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'status-summary', id: 'summary-1', payload: { items },
    })).toMatchObject({ type: 'status-summary', payload: { items } });
  });

  test('guard and schema refuse the same malformed lists', () => {
    const invalid: GuestStatusSummaryItem[][] = [
      Array.from({ length: 5 }, () => ({ text: '1' })),
      [{ text: '' }],
      [{ text: 'x'.repeat(17) }],
      [{ text: '1', icon: 'icons/todo.svg' }],
      [{ text: '1', label: 'y'.repeat(61) }],
    ];
    for (const value of invalid) {
      expect(guestStatusSummarySchema.safeParse(value).success).toBe(false);
      expect(isGuestStatusSummary(value)).toBe(false);
    }
    for (const value of [[{ text: '1', tone: 'loud' }], [{ text: '1', extra: true }], { text: '1' }]) {
      expect(guestStatusSummarySchema.safeParse(value).success).toBe(false);
    }
  });
});
