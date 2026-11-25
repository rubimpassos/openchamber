import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { notifyCredentialChanged } from '@/lib/opencode/integration-catalog';
import { useProviderAccounts } from '@/hooks/useProviderAccounts';

type SignIn = { id: string; label: string };
const signIns: SignIn[] = [{ id: 'cred_ultra', label: 'Ultra' }, { id: 'cred_team', label: 'Team Premium' }];

let root: Root | null = null;
let shown: string[] = [];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let restoreFetch: (() => void) | undefined;

const Accounts: React.FC<{ sessionId: string; load: (providerId: string) => Promise<SignIn[]> }> = ({ sessionId, load }) => {
  shown = useProviderAccounts('anthropic', true, sessionId, load).map((account) => account.label);
  return null;
};

/** Answers each read from `answers` in turn, the last one from then on. */
const source = (answers: Array<SignIn[] | Error>) => {
  let count = 0;
  const load = async () => {
    count += 1;
    const answer = answers[Math.min(count, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { load, count: () => count };
};

const render = (sessionId: string, load: (providerId: string) => Promise<SignIn[]>) => (
  act(async () => root?.render(<Accounts sessionId={sessionId} load={load} />))
);

const mount = () => {
  const win = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<never>(() => undefined));
  restoreFetch = () => fetch.mockRestore();
  root = createRoot(document.createElement('div'));
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  shown = [];
  restoreFetch?.();
  restoreFetch = undefined;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

describe('useProviderAccounts', () => {
  test('lists the accounts once the catalog refresh after a cold read arrives', async () => {
    const accounts = source([[], signIns]);
    mount();
    await render('ses_1', accounts.load);
    expect(shown).toEqual([]);

    await act(async () => notifyCredentialChanged());

    expect(accounts.count()).toBe(2);
    expect(shown).toEqual(['Ultra', 'Team Premium']);
  });

  test('reads the accounts again when the user opens another session after a failed read', async () => {
    const accounts = source([new Error('timeout'), signIns]);
    mount();
    await render('ses_1', accounts.load);
    expect(shown).toEqual([]);

    await render('ses_2', accounts.load);

    expect(shown).toEqual(['Ultra', 'Team Premium']);
  });
});
