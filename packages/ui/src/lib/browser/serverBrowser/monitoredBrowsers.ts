import { normalizePath } from '@/lib/pathNormalization';

import type { ServerBrowserScope, ServerBrowserState } from './types';

export type MonitoredBrowserControl = 'none' | 'viewer' | 'other';

export type MonitoredBrowser = {
  readonly scopeId: string;
  readonly sessionId: string | null;
  readonly url: string;
  readonly title: string;
  readonly tabCount: number;
  readonly loading: boolean;
  readonly agentActive: boolean;
  readonly control: MonitoredBrowserControl;
  readonly helpReason: string | null;
  readonly lastError: string | null;
  readonly lastActiveMinute: number | null;
  readonly consoleErrors: number;
  readonly consoleWarnings: number;
};

const MINUTE_MS = 60_000;

const controlOf = (state: ServerBrowserState, scope: ServerBrowserScope): MonitoredBrowserControl => {
  if (state.controller !== 'user' || state.selectedScopeId !== scope.id) return 'none';
  return state.viewerInControl ? 'viewer' : 'other';
};

const monitoredBrowser = (state: ServerBrowserState, scope: ServerBrowserScope): MonitoredBrowser => {
  const reported: Partial<ServerBrowserScope> = scope;
  return {
    scopeId: scope.id,
    sessionId: reported.sessionId ?? null,
    url: reported.url ?? '',
    title: reported.title ?? '',
    tabCount: reported.tabs?.length ?? 0,
    loading: reported.isLoading === true,
    agentActive: reported.agentActive === true,
    control: controlOf(state, scope),
    helpReason: state.help?.scopeId === scope.id ? state.help.reason : null,
    lastError: reported.lastError || null,
    lastActiveMinute: reported.lastActivityAt === undefined ? null : Math.floor(reported.lastActivityAt / MINUTE_MS) * MINUTE_MS,
    consoleErrors: reported.problems?.errors ?? 0,
    consoleWarnings: reported.problems?.warnings ?? 0,
  };
};

export const monitoredBrowsers = (state: ServerBrowserState | null, directory: string): MonitoredBrowser[] => {
  const project = normalizePath(directory);
  if (!state || !project) return [];
  return state.scopes
    .filter((scope) => scope.signIn !== true && normalizePath(scope.directory) === project)
    .map((scope) => monitoredBrowser(state, scope));
};

export const browserMemoryKey = (browsers: readonly MonitoredBrowser[]): string => browsers
  .map((browser) => [browser.scopeId, browser.tabCount, browser.url, browser.agentActive, browser.loading].join('\t'))
  .join('\n');
