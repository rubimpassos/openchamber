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

  const render = async (interruption: RestartInterruption, priority = false) => {
    const continued: string[] = [];
    let dismissed = 0;
    const onContinue = (text: string) => { continued.push(text); };
    const onDismiss = () => { dismissed += 1; };
    await act(async () => {
      root.render(
        <I18nProvider>
          <RestartInterruptionNotice
            interruption={interruption}
            priority={priority}
            formatTime={(timestamp) => (timestamp === 1 ? '21:17' : '21:20')}
            dismissing={false}
            onContinue={onContinue}
            onDismiss={onDismiss}
          />
        </I18nProvider>,
      );
    });
    return { continued, dismissedCount: () => dismissed };
  };

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

  test('Continue hands over an editable message naming the command', async () => {
    const { continued } = await render({ at: 1, cause: 'health-timeout', tool: { name: 'shell', input: 'bun run build' }, resume: null });

    await act(async () => button('Continue').click());

    expect(continued).toHaveLength(1);
    const [text] = continued;
    expect(text).toContain('`bun run build`');
    expect(text).toContain('/tmp/opencode');
    expect(text).toContain('`heavy list`');
  });

  test('without a tool or a known cause, says only when, and Continue asks for a state check', async () => {
    const { continued, dismissedCount } = await render({ at: 1, cause: 'unknown', tool: null, resume: null });

    expect(host.textContent).toContain('Interrupted when OpenCode restarted at 21:17.');
    expect(host.querySelector('code')).toBeNull();

    await act(async () => button('Continue').click());
    await act(async () => button('Dismiss').click());

    expect(continued[0].startsWith('OpenCode restarted and cut off your last turn. Before repeating any command')).toBe(true);
    expect(dismissedCount()).toBe(1);
  });

  test('a priority session says it is one and that it will resume once memory frees up', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: { state: 'waiting', at: 2 } }, true);

    expect(host.firstElementChild?.getAttribute('data-priority')).toBe('true');
    expect(host.textContent).toContain('Priority session');
    expect(host.textContent).toContain('Will resume automatically once the server\'s memory frees up.');
    expect(button('Continue')).toBeTruthy();
  });

  test('once the server resumed it, the notice says when and offers no Continue', async () => {
    await render({ at: 1, cause: 'health-timeout', tool: null, resume: { state: 'sent', at: 3 } }, true);

    expect(host.textContent).toContain('Resumed automatically at 21:20.');
    expect([...host.querySelectorAll('button')].map((element) => element.textContent)).toEqual(['Dismiss']);
  });

  test('a resume left to the user says why and offers Continue', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: { state: 'manual', at: 3, reason: 'memory-timeout' } }, true);

    expect(host.textContent).toContain('did not free up in time');
    expect(button('Continue')).toBeTruthy();
  });

  test('an ordinary session never mentions an automatic resume', async () => {
    await render({ at: 1, cause: 'memory-pressure', tool: null, resume: null });

    expect(host.firstElementChild?.getAttribute('data-priority')).toBeNull();
    expect(host.textContent).not.toContain('automatically');
  });
});
