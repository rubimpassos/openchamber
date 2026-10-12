import { expect, test } from 'bun:test';

import { parseTodoChecklist } from './todoList';

test('parseTodoChecklist reads `- [status] content` lines and skips the rest', () => {
  const text = [
    'Incomplete tasks remain in your todo list. Continue working on the next pending task.',
    '',
    '[Status: 1/3 completed, 2 remaining]',
    '',
    'Remaining tasks:',
    '- [in_progress] Relatório final com evidências',
    '- [pending] Cleanup [temp] files',
    '- [unknown] not a todo',
  ].join('\n');
  expect(parseTodoChecklist(text)).toEqual([
    { status: 'in_progress', content: 'Relatório final com evidências' },
    { status: 'pending', content: 'Cleanup [temp] files' },
  ]);
  expect(parseTodoChecklist('no list here')).toBeNull();
});
