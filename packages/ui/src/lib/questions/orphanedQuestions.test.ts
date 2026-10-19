import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Part, QuestionRequest, Session } from '@/lib/opencode/model';
import {
  ORPHANED_QUESTION_ID_PREFIX,
  buildOrphanedAnswerMessage,
  collectOrphanedQuestionRequests,
  isOrphanedQuestionDismissed,
  isOrphanedQuestionId,
  inactivityInterruptionAt,
  markOrphanedQuestionDismissed,
  type OrphanedQuestion,
  type OrphanedQuestionRecords,
} from './orphanedQuestions';
import { projectQuestionForm, questionToForm } from '@/lib/opencode/projection';

let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

beforeEach(() => {
  ensureLocalStorage();
});

afterAll(() => {
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

const SESSION_ID = 'ses_test';

const NONE: OrphanedQuestionRecords = { inactivityAt: null, restartCut: null };
const INACTIVITY: OrphanedQuestionRecords = { inactivityAt: 200, restartCut: null };
const restartCut = (overrides: Partial<NonNullable<OrphanedQuestionRecords['restartCut']>> = {}): OrphanedQuestionRecords => ({
  inactivityAt: null,
  restartCut: { messageID: 'msg_assistant', at: 300, callID: 'call_1', toolName: 'question', ...overrides },
});

const questionInput = {
  questions: [
    {
      question: 'Which mode should we use?',
      header: 'Mode',
      options: [
        { label: 'safe', description: 'Default' },
        { label: 'aggressive', description: '' },
      ],
    },
  ],
};

function makeAssistantInfo(overrides?: Partial<AssistantMessage>): Message {
  return {
    id: 'msg_assistant',
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: 1 },
    modelID: 'model-x',
    providerID: 'provider-x',
    agent: 'build',
    cost: 0,
    ...overrides,
  };
}

function makeQuestionToolPart(options?: {
  status?: 'pending' | 'running' | 'completed' | 'error';
  callID?: string;
  input?: unknown;
}): Part {
  const status = options?.status ?? 'running';
  const input = options && 'input' in options ? options.input : questionInput;
  const state = status === 'completed'
    ? { status, input, output: 'done', title: '', metadata: {}, time: { start: 1, end: 2 } }
    : status === 'error'
      ? { status, input, error: 'Tool execution interrupted', time: { start: 1, end: 2 } }
      : status === 'pending'
        ? { status, input, raw: '' }
        : { status, input, time: { start: 1 } };
  return {
    id: 'prt_question',
    sessionID: SESSION_ID,
    messageID: 'msg_assistant',
    type: 'tool',
    callID: options?.callID ?? 'call_1',
    tool: 'question',
    state,
  } as Part;
}

function makeRecords(parts: Part[], info?: Message): Array<{ info: Message; parts: Part[] }> {
  return [{ info: info ?? makeAssistantInfo(), parts }];
}

function makeLiveQuestion(callID: string): QuestionRequest {
  return {
    id: 'que_live',
    sessionID: SESSION_ID,
    questions: questionInput.questions,
    tool: { messageID: 'msg_assistant', callID },
  };
}

describe('collectOrphanedQuestionRequests', () => {
  test('ignores a v2 idle marker after the interrupted assistant tool', () => {
    const records = makeRecords([makeQuestionToolPart()]);
    records.push({
      info: { id: 'idle', sessionID: SESSION_ID, role: 'idle', time: { created: 2 }, outcome: 'interrupted' },
      parts: [],
    });
    expect(collectOrphanedQuestionRequests(SESSION_ID, records, [], NONE)).toHaveLength(1);
  });

  test('projects v2 form metadata to the original tool call identity', () => {
    const question = makeLiveQuestion('call_1');
    const form = {
      ...questionToForm(question),
      metadata: { kind: 'question', tool: { id: 'call_1', messageID: 'msg_assistant' } },
    };
    const projected = projectQuestionForm(form);
    expect(projected?.tool).toEqual(question.tool);
    expect(form.fields[0].key).toBe('q0');
    expect(form.fields[0].type).toBe('string');
    expect(collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), projected ? [projected] : [], NONE)).toHaveLength(0);
  });

  test('synthesizes a request from a stale running question tool part', () => {
    const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), [], NONE);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe(`${ORPHANED_QUESTION_ID_PREFIX}call_1`);
    expect(orphaned[0].sessionID).toBe(SESSION_ID);
    expect(orphaned[0].questions[0].question).toBe('Which mode should we use?');
    expect(orphaned[0].questions[0].options).toHaveLength(2);
    expect(orphaned[0].tool).toEqual({ messageID: 'msg_assistant', callID: 'call_1' });
    expect(isOrphanedQuestionId(orphaned[0].id)).toBe(true);
  });

  test('detects pending tool parts too', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ status: 'pending' })]),
      [],
      NONE,
    );
    expect(orphaned).toHaveLength(1);
  });

  test('ignores completed question tool parts, and errored ones unless the inactivity eviction errored them', () => {
    for (const status of ['completed', 'error'] as const) {
      const orphaned = collectOrphanedQuestionRequests(
        SESSION_ID,
        makeRecords([makeQuestionToolPart({ status })]),
        [],
        NONE,
      );
      expect(orphaned).toHaveLength(0);
    }
  });

  test('brings back a question errored by an inactivity interruption', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ status: 'error' })]),
      [],
      INACTIVITY,
    );
    expect(orphaned.map((question) => question.id)).toEqual([`${ORPHANED_QUESTION_ID_PREFIX}call_1`]);
    expect(orphaned[0].cause).toEqual({ kind: 'inactivity', at: 200 });
  });

  test('a restart that cut the question off keeps it answerable once the UI marks it errored', () => {
    for (const status of ['running', 'error'] as const) {
      const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart({ status })]), [], restartCut());
      expect(orphaned.map((question) => question.cause)).toEqual([{ kind: 'opencode-restart', at: 300 }]);
    }
  });

  test('a restart mark for another message or tool call does not bring an errored question back', () => {
    for (const records of [restartCut({ messageID: 'msg_other' }), restartCut({ callID: 'call_other' })]) {
      expect(collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart({ status: 'error' })]), [], records)).toHaveLength(0);
    }
  });

  test('the pending-question record names the exact call and its cause', () => {
    const pending = { messageID: 'msg_assistant', callID: 'call_1', title: 'Mode?', cause: 'inactivity' as const, at: 400 };
    const records = { ...NONE, pending };
    expect(collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart({ status: 'error' })]), [], records)
      .map((question) => question.cause)).toEqual([{ kind: 'inactivity', at: 400 }]);
    const otherCall = { ...NONE, pending: { ...pending, callID: 'call_other' } };
    expect(collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart({ status: 'error' })]), [], otherCall)).toHaveLength(0);
  });

  test('a stranded question with no record says nothing about its cause', () => {
    const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), [], NONE);
    expect(orphaned[0].cause).toEqual({ kind: 'unknown' });
  });

  test('looks past the agent switch and idle marker OpenCode records after an interrupted turn', () => {
    const records = makeRecords([makeQuestionToolPart({ status: 'error' })]);
    records.push(
      {
        info: { id: 'switch', sessionID: SESSION_ID, role: 'agent-switched', time: { created: 2 }, agent: 'build', previous: 'build' },
        parts: [],
      },
      { info: { id: 'idle', sessionID: SESSION_ID, role: 'idle', time: { created: 3 }, outcome: 'interrupted' }, parts: [] },
    );
    expect(collectOrphanedQuestionRequests(SESSION_ID, records, [], INACTIVITY)).toHaveLength(1);
  });

  test('excludes questions still pending server-side (matched by callID)', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ callID: 'call_1' })]),
      [makeLiveQuestion('call_1')],
      NONE,
    );
    expect(orphaned).toHaveLength(0);
  });

  test('keeps orphans whose callID differs from live questions', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ callID: 'call_2' })]),
      [makeLiveQuestion('call_1')],
      NONE,
    );
    expect(orphaned).toHaveLength(1);
  });

  test('only considers the last message', () => {
    const records = [
      { info: makeAssistantInfo({ id: 'msg_old' }), parts: [makeQuestionToolPart()] },
      {
        info: { id: 'msg_user2', sessionID: SESSION_ID, role: 'user', time: { created: 2 } } as Message,
        parts: [],
      },
    ];
    expect(collectOrphanedQuestionRequests(SESSION_ID, records, [], NONE)).toHaveLength(0);
  });

  test('ignores non-assistant last message and mismatched session', () => {
    const userRecord = makeRecords(
      [makeQuestionToolPart()],
      { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 1 } } as Message,
    );
    expect(collectOrphanedQuestionRequests(SESSION_ID, userRecord, [], NONE)).toHaveLength(0);

    const otherSession = makeRecords([makeQuestionToolPart()], makeAssistantInfo({ sessionID: 'ses_other' }));
    expect(collectOrphanedQuestionRequests(SESSION_ID, otherSession, [], NONE)).toHaveLength(0);
  });

  test('skips malformed tool input', () => {
    for (const input of [undefined, {}, { questions: 'nope' }, { questions: [{ header: 'no question text' }] }]) {
      const orphaned = collectOrphanedQuestionRequests(
        SESSION_ID,
        makeRecords([makeQuestionToolPart({ input })]),
        [],
        NONE,
      );
      expect(orphaned).toHaveLength(0);
    }
  });

  test('excludes dismissed questions', () => {
    markOrphanedQuestionDismissed('call_1');
    expect(isOrphanedQuestionDismissed('call_1')).toBe(true);
    const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), [], NONE);
    expect(orphaned).toHaveLength(0);
  });
});

describe('inactivityInterruptionAt', () => {
  const session = (interruption: { reason?: string; at?: number } | null, idle: number): Session => ({
    id: SESSION_ID,
    projectID: 'prj',
    directory: '/repo',
    title: 'test',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1, idle },
    metadata: interruption === null ? {} : { openchamber: { interruption } },
  });

  test('is the time of an inactivity record written after the last idle time', () => {
    expect(inactivityInterruptionAt(session({ reason: 'inactivity', at: 200 }, 100))).toBe(200);
  });

  test('is null for a user stop or a superseded turn', () => {
    expect(inactivityInterruptionAt(session({ reason: 'user', at: 200 }, 100))).toBeNull();
    expect(inactivityInterruptionAt(session({ reason: 'superseded', at: 200 }, 100))).toBeNull();
  });

  test('is null once a later turn has ended', () => {
    expect(inactivityInterruptionAt(session({ reason: 'inactivity', at: 200 }, 300))).toBeNull();
  });

  test('is null without a record or with a malformed one', () => {
    expect(inactivityInterruptionAt(undefined)).toBeNull();
    expect(inactivityInterruptionAt(session(null, 100))).toBeNull();
    expect(inactivityInterruptionAt(session({ reason: 'inactivity' }, 100))).toBeNull();
  });
});

describe('buildOrphanedAnswerMessage', () => {
  const request: OrphanedQuestion = {
    id: `${ORPHANED_QUESTION_ID_PREFIX}call_1`,
    sessionID: SESSION_ID,
    questions: [
      { question: 'Which mode?', header: 'Mode', options: [] },
      { question: 'Which color?', header: 'Color', options: [] },
    ],
    tool: { messageID: 'msg_assistant', callID: 'call_1' },
    cause: { kind: 'opencode-restart', at: 300 },
  };

  test('pairs each question with its answers and says what cut it off', () => {
    const text = buildOrphanedAnswerMessage(request, [['safe'], ['red', 'blue']], request.cause);
    expect(text).toContain('"Which mode?"="safe"');
    expect(text).toContain('"Which color?"="red, blue"');
    expect(text).toContain('interrupted before I could answer, because OpenCode restarted.');
  });

  test('names the inactivity eviction, and no cause it does not know', () => {
    expect(buildOrphanedAnswerMessage(request, [['safe']], { kind: 'inactivity', at: 1 }))
      .toContain('because OpenCode stopped the session after an hour without activity.');
    expect(buildOrphanedAnswerMessage(request, [['safe']], { kind: 'unknown' }))
      .toContain('interrupted before I could answer. Here are my answers');
  });

  test('skips empty answers and handles none provided', () => {
    const text = buildOrphanedAnswerMessage(request, [[], ['  ']], request.cause);
    expect(text).toContain('(no answer provided)');
  });
});

describe('dismissal persistence', () => {
  test('round-trips and survives duplicate marks', () => {
    expect(isOrphanedQuestionDismissed('call_x')).toBe(false);
    markOrphanedQuestionDismissed('call_x');
    markOrphanedQuestionDismissed('call_x');
    expect(isOrphanedQuestionDismissed('call_x')).toBe(true);
    expect(isOrphanedQuestionDismissed('call_y')).toBe(false);
  });

  test('ignores malformed stored payloads', () => {
    localStorage.setItem('oc.orphanedQuestionDismissals', '{not json');
    expect(isOrphanedQuestionDismissed('call_x')).toBe(false);
    markOrphanedQuestionDismissed('call_x');
    expect(isOrphanedQuestionDismissed('call_x')).toBe(true);
  });
});
