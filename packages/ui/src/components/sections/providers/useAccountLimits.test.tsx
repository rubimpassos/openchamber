import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { notifyCredentialChanged } from '@/lib/opencode/integration-catalog';
import { useSessionAccountUsage } from '@/components/chat/work-status/useSessionAccountUsage';
import { useAccountLimits } from './useProviderAccountMode';

const account = { id: 'cred_team', label: 'Team Premium', usage: { windows: {} }, exhausted: [] };
const json = (text: string) => new Response(text, { headers: { 'content-type': 'application/json' } });

/** The first answer for each route, then `later` (a pending or failed read) from then on. */
const stubServer = (later: () => Promise<Response>) => {
  const seen = new Set<string>();
  return spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (seen.has(path)) return later();
    seen.add(path);
    if (path.endsWith('/accounts')) return json(JSON.stringify({ providerID: 'anthropic', usageAt: 1, accounts: [account] }));
    return json(JSON.stringify({ config: { sessionID: 'ses_1', providerID: 'anthropic', mode: 'fixed', credentialID: account.id, updatedAt: 1 }, account: account.id }));
  });
};

let root: Root | null = null;
let limitIds: string[] = [];
let sessionLabel: string | null = null;

const Limits: React.FC = () => {
  limitIds = [...useAccountLimits('anthropic', true).keys()];
  return null;
};

const REFRESH: readonly object[] = [];
const SessionUsage: React.FC = () => {
  sessionLabel = useSessionAccountUsage('ses_1', 'anthropic', 'claude-opus', REFRESH)?.label ?? null;
  return null;
};

const mount = async (node: React.ReactNode) => {
  const win = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(node));
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  limitIds = [];
  sessionLabel = null;
});

describe('account usage readers on a re-read', () => {
  test('the provider page keeps the account usage while the next read is pending', async () => {
    const server = stubServer(() => new Promise<Response>(() => undefined));
    try {
      await mount(<Limits />);
      expect(limitIds).toEqual([account.id]);
      await act(async () => notifyCredentialChanged());
      expect(limitIds).toEqual([account.id]);
    } finally {
      server.mockRestore();
    }
  });

  test('the work status keeps the session account when a re-read fails', async () => {
    const server = stubServer(async () => new Response('busy', { status: 503 }));
    try {
      await mount(<SessionUsage />);
      expect(sessionLabel).toBe('Team Premium');
      await act(async () => notifyCredentialChanged());
      expect(server.mock.calls.length).toBe(4);
      expect(sessionLabel).toBe('Team Premium');
    } finally {
      server.mockRestore();
    }
  });
});
