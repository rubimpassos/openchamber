import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { showRestartInterruptedToast } from './restart-interrupted-toast';
import { setSessionOpener } from './session-navigation';

type Shown = { title: string; options: { description: ReactNode; action?: { label: string; onClick: () => void } } };

describe('showRestartInterruptedToast', () => {
  const opened: Array<[string, string]> = [];
  let shown: Shown[] = [];
  const show = (title: string, options: Shown['options']) => { shown.push({ title, options }); };

  beforeEach(() => {
    opened.length = 0;
    shown = [];
    setSessionOpener((sessionID, directory) => { opened.push([sessionID, directory]); });
  });

  afterEach(() => setSessionOpener(null));

  test('one session keeps the single Open session action', () => {
    showRestartInterruptedToast({ kind: 'opencode-restart-interrupted', sessionId: 'ses_1', directory: '/repo', sessions: [{ sessionId: 'ses_1', directory: '/repo' }] }, '', show);

    const [{ title, options }] = shown;
    expect(title).toBe('Chat interrupted');
    expect(options.action?.label).toBe('Open session');
    options.action?.onClick();
    expect(opened).toEqual([['ses_1', '/repo']]);
  });

  test('a notification from an older server still opens its one session', () => {
    showRestartInterruptedToast({ kind: 'opencode-restart-interrupted', sessionId: 'ses_old' }, '/fallback', show);

    shown[0].options.action?.onClick();
    expect(opened).toEqual([['ses_old', '/fallback']]);
  });

  test('several sessions are counted and each one opens its own chat', async () => {
    showRestartInterruptedToast({
      kind: 'opencode-restart-interrupted',
      sessionId: 'ses_1',
      sessions: [
        { sessionId: 'ses_1', directory: '/repo', title: 'Migration' },
        { sessionId: 'ses_2', directory: '/other' },
      ],
    }, '', show);

    const [{ title, options }] = shown;
    expect(title).toBe('2 chats interrupted');
    expect(options.action).toBeUndefined();

    const windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(options.description));

    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((element) => element.textContent)).toEqual(['Migration', 'Untitled session']);
    await act(async () => buttons[1].click());
    expect(opened).toEqual([['ses_2', '/other']]);

    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });
});
