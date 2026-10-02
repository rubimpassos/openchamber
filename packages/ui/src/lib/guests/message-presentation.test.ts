import { describe, expect, test } from 'bun:test';

import { compileGuestMessageRules, guestMessageBodyText, matchGuestMessageRule } from './message-presentation';
import type { InstalledGuest } from './types';

const guest = (overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id: 'omo',
  name: 'OMO',
  icon: 'robot-2',
  enabled: true,
  capabilities: { requested: [], granted: [] },
  messages: [
    { match: '^\\[BACKGROUND TASK (?<status>[A-Z ]+)\\]$[\\s\\S]*?\\*\\*Description:\\*\\* (?<description>.+)', name: 'Background task', title: 'Background task {match.status}', subtitle: '{match.description}', tone: 'success' },
    { match: '<!-- OMO_INTERNAL_INITIATOR -->', name: 'Oh-My-OpenAgent' },
  ],
  ...overrides,
});

const notice = [
  '<system-reminder>',
  '[BACKGROUND TASK COMPLETED]',
  '**ID:** `bg_1`',
  '**Description:** Find the auth middleware',
  '</system-reminder>',
  '<!-- OMO_INTERNAL_INITIATOR -->',
].join('\n');

describe('guest message presentation', () => {
  test('the first matching rule claims the message and fills its templates from named groups', () => {
    const presentation = matchGuestMessageRule(compileGuestMessageRules([guest()]), notice);
    expect(presentation?.title).toBe('Background task COMPLETED');
    expect(presentation?.subtitle).toBe('Find the auth middleware');
    expect(presentation?.rule.tone).toBe('success');
    expect(presentation?.body).toBe('[BACKGROUND TASK COMPLETED]\n**ID:** `bg_1`\n**Description:** Find the auth middleware');
  });

  test('a later rule catches what the specific ones miss; plain user text keeps its bubble', () => {
    const rules = compileGuestMessageRules([guest()]);
    expect(matchGuestMessageRule(rules, 'Keep going\n<!-- OMO_INTERNAL_INITIATOR -->')?.title).toBe('Oh-My-OpenAgent');
    expect(matchGuestMessageRule(rules, 'please fix the [BACKGROUND TASK COMPLETED] parser')).toBeNull();
  });

  test('paused, unapproved, or broken rules never apply', () => {
    expect(compileGuestMessageRules([guest({ enabled: false })])).toHaveLength(0);
    expect(compileGuestMessageRules([guest({ messages: [{ match: '([', name: 'broken' }] })])).toHaveLength(0);
  });

  test('the body drops HTML comments and system-reminder tags', () => {
    expect(guestMessageBodyText('<system-reminder>\nhello\n</system-reminder>\n\n\n<!-- X -->')).toBe('hello');
  });
});
