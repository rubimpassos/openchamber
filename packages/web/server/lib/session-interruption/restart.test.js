import { describe, expect, it } from 'vitest';

import { findInterruptedTool, restartInterruptedNotification } from './restart.js';

const user = { id: 'msg_u', type: 'user', text: 'run the migration' };
const tool = (name, state) => ({ type: 'tool', id: `call_${name}`, name, state });
const assistant = (...content) => ({ id: 'msg_a', type: 'assistant', content });
const aborted = (input) => ({ status: 'error', input, error: { type: 'aborted', message: 'Tool execution interrupted: shell' } });

describe('findInterruptedTool', () => {
  it('names the tool OpenCode aborted and its command', () => {
    const records = [
      { id: 'msg_i', type: 'idle', outcome: 'interrupted' },
      assistant(
        tool('read', { status: 'completed', input: { filePath: '/repo/a.ts' }, content: [{ type: 'text', text: 'x' }] }),
        tool('shell', aborted({ command: 'sleep 600', description: 'Wait' })),
      ),
      user,
    ];

    expect(findInterruptedTool(records)).toEqual({ name: 'shell', input: 'sleep 600' });
  });

  it('takes a tool the dead process left running', () => {
    expect(findInterruptedTool([assistant(tool('webfetch', { status: 'running', input: { url: 'https://example.com' }, metadata: {} })), user]))
      .toEqual({ name: 'webfetch', input: 'https://example.com' });
  });

  it('flattens and truncates a long command', () => {
    const command = `bun run build\n${'x'.repeat(400)}`;
    const found = findInterruptedTool([assistant(tool('shell', aborted({ command })))]);

    expect(found.input.startsWith('bun run build x')).toBe(true);
    expect(found.input).toHaveLength(200);
    expect(found.input.endsWith('…')).toBe(true);
  });

  it('keeps the name when the input says nothing readable', () => {
    expect(findInterruptedTool([assistant(tool('todo', aborted({ items: [1, 2] })))])).toEqual({ name: 'todo' });
  });

  it('does not reach into an earlier turn', () => {
    const records = [
      assistant(tool('read', { status: 'completed', input: { filePath: 'a' }, content: [{ type: 'text', text: 'x' }] })),
      user,
      assistant(tool('shell', aborted({ command: 'old' }))),
    ];

    expect(findInterruptedTool(records)).toBeNull();
  });

  it('ignores a tool that failed for its own reasons', () => {
    expect(findInterruptedTool([assistant(tool('shell', { status: 'error', input: { command: 'false' }, error: { type: 'tool', message: 'exit 1' } }))]))
      .toBeNull();
  });
});

describe('restartInterruptedNotification', () => {
  it('lists every interrupted session and names the first for older clients', () => {
    const notification = restartInterruptedNotification([
      { sessionId: 'ses_1', directory: '/repo', title: 'Migration' },
      { sessionId: 'ses_2', directory: '/other', title: null },
      { sessionId: 'ses_3', directory: null, title: null },
    ]);

    expect(notification).toEqual({
      title: 'Chats interrupted',
      body: 'OpenCode restarted during 3 running responses. Open each chat to continue.',
      tag: 'opencode-restart-interrupted',
      kind: 'opencode-restart-interrupted',
      sessionId: 'ses_1',
      directory: '/repo',
      sessions: [
        { sessionId: 'ses_1', directory: '/repo', title: 'Migration' },
        { sessionId: 'ses_2', directory: '/other' },
        { sessionId: 'ses_3' },
      ],
    });
  });

  it('keeps the single-chat wording for one session', () => {
    expect(restartInterruptedNotification([{ sessionId: 'ses_1', directory: '/repo', title: 'A' }])).toMatchObject({
      title: 'Chat interrupted',
      sessionId: 'ses_1',
      sessions: [{ sessionId: 'ses_1', directory: '/repo', title: 'A' }],
    });
  });
});
