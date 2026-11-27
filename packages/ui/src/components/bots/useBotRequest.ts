import React from 'react';
import { z } from 'zod';
import { BotsApiError, ensureBotConversation, fetchBotItem } from '@/lib/botsApi';
import { botArtifactFailure, fetchBotArtifacts, type BotArtifact, type BotArtifactFailure } from '@/lib/bots/artifacts';
import type { BotConversation, BotItem } from '@/lib/bots/items';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/** A visible visit refreshes from the shared control stream. No idle polling or project fan-out. */
export function useBotsRefresh(projectId: string | null, refresh: () => void, enabled = true) {
  React.useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'event-stream-ready' && !(event.type === 'bots-changed' && (projectId === null || event.projectId === projectId))) return;
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; refresh(); }, 200);
    });
    return () => { release(); if (timer !== undefined) clearTimeout(timer); };
  }, [projectId, refresh, enabled]);
}

/** Every mounted read belongs to this visit. Failure retains only this visit's prior result. */
export function useBotResource<T>(load: () => Promise<T>) {
  const [read, setRead] = React.useState<{ readonly owner: typeof load; readonly data: T | null; readonly busy: boolean; readonly error: boolean; readonly reason: BotArtifactFailure | null }>({ owner: load, data: null, busy: true, error: false, reason: null });
  const [attempt, setAttempt] = React.useState(0);
  const revision = React.useRef(0);
  React.useEffect(() => {
    let active = true;
    const runtime = getBotsRuntime();
    const request = ++revision.current;
    setRead((current) => ({ owner: load, data: current.owner === load ? current.data : null, busy: true, error: false, reason: null }));
    void (async () => {
      try {
        const data = await load();
        if (active && !runtime.signal.aborted && request === revision.current) setRead({ owner: load, data, busy: false, error: false, reason: null });
      } catch (failure) {
        if (active && !runtime.signal.aborted && request === revision.current) setRead((current) => ({ ...current, busy: false, error: true, reason: failure instanceof BotsApiError ? botArtifactFailure(failure) : 'failed' }));
      }
    })();
    return () => { active = false; };
  }, [load, attempt]);
  const refresh = React.useCallback(() => setAttempt((current) => current + 1), []);
  const replace = (data: T) => {
    revision.current += 1;
    setRead({ owner: load, data, busy: false, error: false, reason: null });
  };
  return { data: read.owner === load ? read.data : null, busy: read.owner !== load || read.busy, error: read.owner === load && read.error, reason: read.owner === load ? read.reason : null, refresh, replace };
}

export function useBotItemRead(projectId: string, initial: BotItem, archived: boolean) {
  const load = React.useCallback(() => fetchBotItem(projectId, initial.id), [projectId, initial.id]);
  const read = useBotResource(load);
  useBotsRefresh(projectId, read.refresh, !archived);
  return { read, item: read.data?.item ?? initial };
}

export function useBotConversation(projectId: string, item: BotItem, canCreate: boolean) {
  const [adopted, setAdopted] = React.useState<BotConversation | null>(item.conversation ?? null);
  const needed = !adopted && !item.conversation && canCreate;
  const load = React.useCallback(
    () => needed ? ensureBotConversation(projectId, item.id).then((result) => result.conversation) : Promise.resolve(null),
    [needed, projectId, item.id],
  );
  const read = useBotResource(load);
  const conversation = adopted ?? item.conversation ?? read.data;
  if (!adopted && conversation) setAdopted(conversation);
  return { conversation, busy: needed && read.busy, error: needed && read.error, retry: read.refresh };
}

export function useBotArtifacts(scope: { readonly projectId: string; readonly itemId: string }, wanted: boolean, live: boolean) {
  const { projectId, itemId } = scope;
  const load = React.useCallback(async () => {
    if (!wanted) return null;
    const artifacts: BotArtifact[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await fetchBotArtifacts({ projectId, itemId }, { offset });
      artifacts.push(...page.artifacts);
      if (page.nextOffset !== null && page.nextOffset <= offset) throw new BotsApiError(502, 'BOT_ARTIFACT_READ_FAILED');
      offset = page.nextOffset;
    }
    return artifacts;
  }, [projectId, itemId, wanted]);
  const read = useBotResource(load);
  useBotsRefresh(projectId, read.refresh, wanted && live);
  return { ...read, failure: read.reason };
}

const REQUEST_ERROR_KEYS = new Map<string, I18nKey>([
  ['BOT_DEFINITIONS_CHANGED', 'bots.requestError.changed'], ['BOT_INVALID_REQUEST', 'bots.requestError.invalid'],
  ['BOT_PROJECT_ACCESS_REQUIRED', 'bots.requestError.projectAccess'], ['BOT_NOT_ENABLED', 'bots.requestError.notEnabled'],
  ['BOT_DEFINITION_REQUIRED', 'bots.requestError.missingBot'], ['BOT_REQUEST_FAILED', 'bots.requestError.server'],
  ['enterprise_mode', 'bots.enterprise'], ['bots_unsupported', 'bots.unsupported'],
]);
const requestErrorKey = (failure: Error): I18nKey => {
  if (failure instanceof z.ZodError) return 'bots.validation';
  if (failure instanceof TypeError) return 'bots.requestError.network';
  if (!(failure instanceof BotsApiError)) return 'bots.error';
  return REQUEST_ERROR_KEYS.get(failure.code) ?? (failure.status >= 500 ? 'bots.requestError.server' : 'bots.error');
};

/** Serializes explicit user actions and rejects navigation from a retired runtime or visit. */
export function useBotAction() {
  const { t } = useI18n();
  const ownerRuntime = getBotsRuntime();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const active = React.useRef(true);
  const running = React.useRef(false);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    const runtime = getBotsRuntime();
    running.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (failure) {
      if (!active.current || runtime.signal.aborted) return;
      if (!(failure instanceof Error)) throw failure;
      setError(t(requestErrorKey(failure)));
    } finally {
      running.current = false;
      if (active.current && !runtime.signal.aborted) setBusy(false);
    }
  };
  return { busy, error, run, isActive: () => active.current && !ownerRuntime.signal.aborted };
}
