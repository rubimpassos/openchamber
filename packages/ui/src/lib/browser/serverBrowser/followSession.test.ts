import { describe, expect, test } from 'bun:test';
import { followsBrowserSession } from './followSession';

const target = { guestId: 'browser', directory: '/repo', sessionId: 'chat-a' };
const cases = [
  { name: 'the requesting chat', shown: target, following: true, expected: true },
  { name: 'another chat in the same project', shown: { ...target, sessionId: 'chat-b' }, following: true, expected: false },
  { name: 'a new-session draft', shown: { ...target, sessionId: null }, following: true, expected: false },
  { name: 'another project', shown: { ...target, directory: '/other' }, following: true, expected: false },
  { name: 'another browser provider', shown: { ...target, guestId: 'other' }, following: true, expected: false },
  { name: 'following turned off', shown: target, following: false, expected: false },
];

describe('following the browser of the session on screen', () => {
  for (const entry of cases) {
    test(entry.name, () => {
      expect(followsBrowserSession(target, entry.shown, entry.following)).toBe(entry.expected);
    });
  }
});
