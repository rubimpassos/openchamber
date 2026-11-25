import { describe, expect, test } from 'bun:test';

import { compileGuestMessageRules, guestMessageBodyText, isGuestMessageIn, matchGuestMessageRule } from './message-presentation';
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

  test('a user message is a plugin message only under a catalog whose active rules claim it', () => {
    const catalog = [guest({
      messages: [
        { match: '^\\[ALL TASKS COMPLETE\\]', name: 'All tasks complete', tone: 'success' },
        { match: '^\\[TASK (?<status>DONE|FAILED|RETRYING)\\]', name: 'Task', subtitle: '{match.status}' },
        { match: '\\[DIRECTIVE - TODO CONTINUATION\\]', name: 'Todo continuation', body: 'todos' },
        { match: '<peer_message\\b[^>]*\\bfrom="(?<from>[^"]+)"', name: 'Team message', subtitle: 'from {match.from}' },
      ],
    })];
    const parts = (text: string) => [{ type: 'text', text }];
    const claimed = [
      '[ALL TASKS COMPLETE]',
      '[TASK DONE]\n**Description:** Find the auth middleware',
      '[TASK FAILED]\n**Error:** provider unavailable',
      '[TASK RETRYING]\n- Next model: `other/model`',
      '[DIRECTIVE - TODO CONTINUATION]\n\n- [in_progress] Check the grouping',
      '<peer_message messageId="m1" from="reviewer">The review is ready.</peer_message>',
    ].map(parts);
    const aggregate = claimed[0];
    if (!aggregate) throw new Error('Expected an aggregate task message');
    expect(claimed.map((message) => isGuestMessageIn(catalog, message))).toEqual([true, true, true, true, true, true]);
    expect(isGuestMessageIn(catalog, parts('please fix the [TASK DONE] parser'))).toBe(false);
    expect(isGuestMessageIn(catalog, [{ type: 'file' }])).toBe(false);
    // The same message under another catalog: the extension paused, no extension at all, other rules.
    expect(claimed.map((message) => isGuestMessageIn([guest({ ...catalog[0], enabled: false })], message))).toEqual([false, false, false, false, false, false]);
    expect(isGuestMessageIn([], aggregate)).toBe(false);
    const updated = [guest({ messages: [{ match: '^\\[TASK DONE\\]', name: 'Task' }] })];
    expect(claimed.map((message) => isGuestMessageIn(updated, message))).toEqual([false, true, false, false, false, false]);
    expect(isGuestMessageIn(catalog, aggregate)).toBe(true);
  });
});
