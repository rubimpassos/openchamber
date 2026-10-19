import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { RestartInterruption } from '@/lib/sessionRestartInterruption';
import { RestartInterruptionNotice } from './SessionRestartInterruptionRow';

describe('RestartInterruptionNotice', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });

  const render = async (
    interruption: RestartInterruption,
    { priority = false, continueAvailable = true } = {},
  ) => {
    let continued = 0;
    let dismissed = 0;
    await act(async () => {
      root.render(
        <I18nProvider>
          <RestartInterruptionNotice
            interruption={interruption}
            priority={priority}
            continueAvailable={continueAvailable}
            formatTime={(timestamp) => (timestamp === 1 ? '21:17' : '21:20')}
            busy={false}
            onContinue={() => { continued += 1; }}
            onDismiss={() => { dismissed += 1; }}
          />
        </I18nProvider>,
      );
    });
    return { continuedCount: () => continued, dismissedCount: () => dismissed };
  };

  const buttonLabels = () => [...host.querySelectorAll('button')].map((element) => element.textContent);

  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((element) => element.textContent === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  };

  test('says when, why and what was running', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: { name: 'shell', input: 'sleep 600' }, resume: null });

    expect(host.textContent).toContain('Interrupted when OpenCode restarted at 21:17. The server ran out of memory.');
    expect(host.textContent).toContain('Running command:');
    expect(host.querySelector('code')?.textContent).toBe('sleep 600');
  });

  test('Continue and Dismiss each ask for their action once', async () => {
    const { continuedCount, dismissedCount } = await render({ at: 1, cause: 'unknown', tool: null, resume: null });

    expect(host.textContent).toContain('Interrupted when OpenCode restarted at 21:17.');
    expect(host.querySelector('code')).toBeNull();

    await act(async () => button('Continue').click());
    await act(async () => button('Dismiss').click());

    expect(continuedCount()).toBe(1);
    expect(dismissedCount()).toBe(1);
  });

  test('a cut-off question that can no longer be answered falls back to Continue', async () => {
    await render(
      { at: 1, cause: 'process-exited', tool: { name: 'question' }, resume: { state: 'manual', at: 1, reason: 'question-pending' } },
      { priority: true },
    );

    expect(host.textContent).toContain('A question was waiting for your answer.');
    expect(host.textContent).toContain('Not resumed automatically, because the question needs your answer.');
    expect(host.textContent).not.toContain('Running command');
    expect(buttonLabels()).toEqual(['Continue', 'Dismiss']);
  });

  test('a runtime that cannot send the resume offers only Dismiss', async () => {
    await render({ at: 1, cause: 'unknown', tool: null, resume: null }, { continueAvailable: false });

    expect(buttonLabels()).toEqual(['Dismiss']);
  });

  test('a priority session says it is one and that it will resume once memory frees up', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: { state: 'waiting', at: 2 } }, { priority: true });

    expect(host.firstElementChild?.getAttribute('data-priority')).toBe('true');
    expect(host.textContent).toContain('Priority session');
    expect(host.textContent).toContain('Will resume automatically once the server\'s memory frees up.');
    expect(button('Continue')).toBeTruthy();
  });

  test('once the server resumed it, the notice says when and offers no Continue', async () => {
    await render({ at: 1, cause: 'health-timeout', tool: null, resume: { state: 'sent', at: 3 } }, { priority: true });

    expect(host.textContent).toContain('Resumed automatically at 21:20.');
    expect(buttonLabels()).toEqual(['Dismiss']);
  });

  test('a resume left to the user says why and offers Continue', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: { state: 'manual', at: 3, reason: 'memory-timeout' } }, { priority: true });

    expect(host.textContent).toContain('did not free up in time');
    expect(button('Continue')).toBeTruthy();
  });

  test('an ordinary session never mentions an automatic resume', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: null });

    expect(host.firstElementChild?.getAttribute('data-priority')).toBeNull();
    expect(host.textContent).not.toContain('automatically');
  });
});
