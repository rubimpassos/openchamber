import { describe, expect, test } from 'bun:test';

import { formatMessage } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { Message } from '@/lib/opencode/model';
import { readOpenChamberResume } from '@/lib/opencode/openchamber-resume';
import { fixLoopTitle } from './fixLoopNoticeTitle';

const t: Parameters<typeof fixLoopTitle>[1] = (key, params) => formatMessage(dict, key, params);

const notice = (metadata: Message['metadata']) => {
  const read = readOpenChamberResume({ id: 'msg_1', sessionID: 'ses_1', role: 'synthetic', time: { created: 1 }, text: 'details', metadata });
  if (read?.kind !== 'fix-loop') throw new Error('not a fix-loop notice');
  return read;
};

describe('fix-loop transcript row title', () => {
  test('names the trigger, PR, commit, sources and iteration', () => {
    const title = fixLoopTitle(notice({
      source: 'openchamber-notice', kind: 'fix-loop', loopId: 'l', trigger: 'review', iteration: 2, maxIterations: 10, headSha: '1a2b3c4d5e6f',
      pr: { owner: 'o', repo: 'r', number: 6, url: 'u', title: 'T' }, checks: [],
      feedback: [
        { type: 'thread', author: 'rubimpassos', url: 'a' }, { type: 'thread', author: 'rubimpassos', url: 'b' },
        { type: 'comment', author: 'b', url: 'c' },
      ],
    }), t);
    expect(title).toBe('Fix loop: new review on #6 · 1a2b3c4 · @rubimpassos, @b · iteration 2/10');
  });

  test('falls back to a plain title for an item queued before the loop described it', () => {
    expect(fixLoopTitle(notice({ source: 'openchamber-notice', kind: 'fix-loop', loopId: 'l' }), t)).toBe('Fix loop update');
  });
});
