import { expect, test } from 'bun:test';

import { rowActionsThatFit } from './browserToolbarRoom';

test('a phone-wide bar keeps the address and sends every action to More', () => {
  expect(rowActionsThatFit({ rowWidth: 390, takenWidth: 182, buttonWidth: 36 })).toBe(0);
});

test('a narrow desktop panel shows only the actions that leave the address readable', () => {
  expect(rowActionsThatFit({ rowWidth: 420, takenWidth: 104, buttonWidth: 24 })).toBe(5);
  expect(rowActionsThatFit({ rowWidth: 340, takenWidth: 104, buttonWidth: 24 })).toBe(2);
});

test('an unmeasured bar shows no action it cannot place', () => {
  expect(rowActionsThatFit({ rowWidth: 0, takenWidth: 0, buttonWidth: 0 })).toBe(0);
});
