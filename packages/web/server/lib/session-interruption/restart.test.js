import { describe, expect, it } from 'vitest';

import { mergeMetadataPatch } from '../openchamber-sessions/session-metadata-store.js';
import { findInterruptedTool, findCutAssistantMessageID, findPendingQuestion, restartInterruptedNotification, restartInterruptionPatch } from './restart.js';

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

    expect(findInterruptedTool(records)).toEqual({ name: 'shell', input: 'sleep 600', callID: 'call_shell' });
  });

  it('takes a tool the dead process left running', () => {
    expect(findInterruptedTool([assistant(tool('webfetch', { status: 'running', input: { url: 'https://example.com' }, metadata: {} })), user]))
      .toEqual({ name: 'webfetch', input: 'https://example.com', callID: 'call_webfetch' });
  });

  it('flattens and truncates a long command', () => {
    const command = `bun run build\n${'x'.repeat(400)}`;
    const found = findInterruptedTool([assistant(tool('shell', aborted({ command })))]);

    expect(found.input.startsWith('bun run build x')).toBe(true);
    expect(found.input).toHaveLength(200);
    expect(found.input.endsWith('…')).toBe(true);
  });

  it('keeps the name when the input says nothing readable', () => {
    expect(findInterruptedTool([assistant(tool('todo', aborted({ items: [1, 2] })))])).toEqual({ name: 'todo', callID: 'call_todo' });
  });

  it('does not reach into an earlier turn', () => {
    const records = [
      assistant(tool('read', { status: 'completed', input: { filePath: 'a' }, content: [{ type: 'text', text: 'x' }] })),
      user,
      assistant(tool('shell', aborted({ command: 'old' }))),
    ];

    expect(findInterruptedTool(records)).toBeNull();
  });

  it('takes a command a graceful stop cancelled as the last part of the turn', () => {
    const cancelled = { status: 'error', input: { command: 'sleep 600' }, error: { type: 'unknown', message: 'Command cancelled' } };
    expect(findInterruptedTool([assistant(tool('shell', cancelled)), user])).toEqual({ name: 'shell', input: 'sleep 600', callID: 'call_shell' });
  });

  it('ignores a tool that failed for its own reasons before the agent went on', () => {
    const failed = tool('shell', { status: 'error', input: { command: 'false' }, error: { type: 'tool', message: 'exit 1' } });
    expect(findInterruptedTool([assistant(failed, { type: 'text', text: 'The command failed.' })])).toBeNull();
    // An older message of the same turn was followed by the newest one.
    expect(findInterruptedTool([{ id: 'msg_b', type: 'assistant', content: [{ type: 'text', text: 'next' }] }, assistant(failed), user])).toBeNull();
  });
});

describe('findCutAssistantMessageID', () => {
  it('names the newest assistant message of the turn, open or completed by OpenCode', () => {
    expect(findCutAssistantMessageID([{ id: 'msg_i', type: 'idle' }, { ...assistant(), time: { created: 1 } }, user])).toBe('msg_a');
    expect(findCutAssistantMessageID([{ ...assistant(), time: { created: 1, completed: 2 } }, user])).toBe('msg_a');
  });

  it('is null when the turn has no assistant message', () => {
    expect(findCutAssistantMessageID([user, { ...assistant(), time: { created: 1 } }])).toBeNull();
  });
});

describe('restartInterruptionPatch', () => {
  it('leaves an ordinary tool to the resume and marks the open turn', () => {
    expect(restartInterruptionPatch({ at: 5, cause: 'unknown', tool: { name: 'shell', callID: 'c' }, messageID: 'msg_a' })).toEqual({
      openchamber: {
        interruption: { reason: 'opencode-restart', at: 5, cause: 'unknown', tool: { name: 'shell', input: null, callID: 'c' }, resume: null },
        restartCutTurn: { messageID: 'msg_a', at: 5, callID: 'c', toolName: 'shell' },
        pendingQuestion: null,
      },
    });
  });

  it('records a cut-off question as waiting for the user, and clears an old turn mark without an open turn', () => {
    expect(restartInterruptionPatch({ at: 5, cause: 'unknown', tool: { name: 'question' } })).toEqual({
      openchamber: {
        interruption: { reason: 'opencode-restart', at: 5, cause: 'unknown', tool: { name: 'question', input: null, callID: null }, resume: { state: 'manual', at: 5, reason: 'question-pending' } },
        restartCutTurn: null,
        pendingQuestion: null,
      },
    });
  });
});

describe('findPendingQuestion', () => {
  const question = (state) => ({ type: 'tool', id: 'call_q', name: 'question', state });
  const asking = { status: 'running', input: { questions: [{ question: 'Which color?' }, { question: 'Size?' }] } };

  it('names the question the newest message was asking, running or errored', () => {
    expect(findPendingQuestion([assistant(question(asking)), user])).toEqual({ messageID: 'msg_a', callID: 'call_q', title: 'Which color?' });
    expect(findPendingQuestion([assistant(question({ ...asking, status: 'error', error: { type: 'aborted' } })), user]))
      .toEqual({ messageID: 'msg_a', callID: 'call_q', title: 'Which color?' });
  });

  it('is null for an answered question, unreadable input, or an earlier message of the turn', () => {
    expect(findPendingQuestion([assistant(question({ ...asking, status: 'completed' }))])).toBeNull();
    expect(findPendingQuestion([assistant(question({ status: 'running', input: { questions: [] } }))])).toBeNull();
    expect(findPendingQuestion([{ id: 'msg_b', type: 'assistant', content: [] }, assistant(question(asking))])).toBeNull();
  });
});

describe('a restart over an earlier record', () => {
  it('replaces the whole tool, so a command from the earlier restart never carries over', () => {
    const first = mergeMetadataPatch({}, restartInterruptionPatch({
      at: 1, cause: 'process-exited', tool: { name: 'shell', input: 'sleep 600', callID: 'c1' }, messageID: 'm1',
    }));
    const second = mergeMetadataPatch(first, restartInterruptionPatch({
      at: 2, cause: 'health-timeout', tool: { name: 'question', callID: 'c2' }, messageID: 'm2',
    }));

    expect(second.openchamber.interruption).toEqual({
      reason: 'opencode-restart', at: 2, cause: 'health-timeout',
      // The null in the patch deletes the earlier `sleep 600`.
      tool: { name: 'question', callID: 'c2' },
      resume: { state: 'manual', at: 2, reason: 'question-pending' },
    });
    expect(second.openchamber.restartCutTurn).toEqual({ messageID: 'm2', at: 2, callID: 'c2', toolName: 'question' });
  });

  it('drops the earlier tool and resume when the new restart cut off none', () => {
    const first = mergeMetadataPatch({}, restartInterruptionPatch({ at: 1, cause: 'unknown', tool: { name: 'question' }, messageID: 'm1' }));
    const second = mergeMetadataPatch(first, restartInterruptionPatch({ at: 2, cause: 'unknown', tool: null }));

    expect(second.openchamber.interruption).toEqual({ reason: 'opencode-restart', at: 2, cause: 'unknown' });
    expect(second.openchamber.restartCutTurn).toBeUndefined();
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
