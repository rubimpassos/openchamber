import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { QuestionRequest } from '@/types/question';
import {
  ORPHANED_QUESTION_ID_PREFIX,
  buildOrphanedAnswerMessage,
  collectOrphanedQuestionRequests,
  isOrphanedQuestionDismissed,
  isOrphanedQuestionId,
  markOrphanedQuestionDismissed,
} from './orphanedQuestions';

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

function makeAssistantInfo(overrides?: Partial<Message>): Message {
  return {
    id: 'msg_assistant',
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg_user',
    modelID: 'model-x',
    providerID: 'provider-x',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/w', root: '/w' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as Message;
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
      ? { status, input, error: 'rejected', time: { start: 1, end: 2 } }
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
  test('synthesizes a request from a stale running question tool part', () => {
    const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), []);
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
    );
    expect(orphaned).toHaveLength(1);
  });

  test('ignores completed and errored question tool parts', () => {
    for (const status of ['completed', 'error'] as const) {
      const orphaned = collectOrphanedQuestionRequests(
        SESSION_ID,
        makeRecords([makeQuestionToolPart({ status })]),
        [],
      );
      expect(orphaned).toHaveLength(0);
    }
  });

  test('excludes questions still pending server-side (matched by callID)', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ callID: 'call_1' })]),
      [makeLiveQuestion('call_1')],
    );
    expect(orphaned).toHaveLength(0);
  });

  test('keeps orphans whose callID differs from live questions', () => {
    const orphaned = collectOrphanedQuestionRequests(
      SESSION_ID,
      makeRecords([makeQuestionToolPart({ callID: 'call_2' })]),
      [makeLiveQuestion('call_1')],
    );
    expect(orphaned).toHaveLength(1);
  });

  test('only considers the last message', () => {
    const records = [
      { info: makeAssistantInfo({ id: 'msg_old' } as Partial<Message>), parts: [makeQuestionToolPart()] },
      {
        info: { id: 'msg_user2', sessionID: SESSION_ID, role: 'user', time: { created: 2 } } as Message,
        parts: [],
      },
    ];
    expect(collectOrphanedQuestionRequests(SESSION_ID, records, [])).toHaveLength(0);
  });

  test('ignores non-assistant last message and mismatched session', () => {
    const userRecord = makeRecords(
      [makeQuestionToolPart()],
      { id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 1 } } as Message,
    );
    expect(collectOrphanedQuestionRequests(SESSION_ID, userRecord, [])).toHaveLength(0);

    const otherSession = makeRecords([makeQuestionToolPart()], makeAssistantInfo({ sessionID: 'ses_other' } as Partial<Message>));
    expect(collectOrphanedQuestionRequests(SESSION_ID, otherSession, [])).toHaveLength(0);
  });

  test('skips malformed tool input', () => {
    for (const input of [undefined, {}, { questions: 'nope' }, { questions: [{ header: 'no question text' }] }]) {
      const orphaned = collectOrphanedQuestionRequests(
        SESSION_ID,
        makeRecords([makeQuestionToolPart({ input })]),
        [],
      );
      expect(orphaned).toHaveLength(0);
    }
  });

  test('excludes dismissed questions', () => {
    markOrphanedQuestionDismissed('call_1');
    expect(isOrphanedQuestionDismissed('call_1')).toBe(true);
    const orphaned = collectOrphanedQuestionRequests(SESSION_ID, makeRecords([makeQuestionToolPart()]), []);
    expect(orphaned).toHaveLength(0);
  });
});

describe('buildOrphanedAnswerMessage', () => {
  const request: QuestionRequest = {
    id: `${ORPHANED_QUESTION_ID_PREFIX}call_1`,
    sessionID: SESSION_ID,
    questions: [
      { question: 'Which mode?', header: 'Mode', options: [] },
      { question: 'Which color?', header: 'Color', options: [] },
    ],
    tool: { messageID: 'msg_assistant', callID: 'call_1' },
  };

  test('pairs each question with its answers', () => {
    const text = buildOrphanedAnswerMessage(request, [['safe'], ['red', 'blue']]);
    expect(text).toContain('"Which mode?"="safe"');
    expect(text).toContain('"Which color?"="red, blue"');
    expect(text).toContain('interrupted');
  });

  test('skips empty answers and handles none provided', () => {
    const text = buildOrphanedAnswerMessage(request, [[], ['  ']]);
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
