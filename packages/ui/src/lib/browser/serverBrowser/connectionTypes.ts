import type { ServerBrowserCapture } from './client';
import type { ServerBrowserScope, ServerBrowserState } from './types';

export type ServerBrowserConnection = {
  readonly state: ServerBrowserState | null;
  readonly scope: ServerBrowserScope | null;
  readonly sessionId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly navigate: (url: string) => Promise<ServerBrowserState | null>;
  readonly back: () => Promise<ServerBrowserState | null>;
  readonly forward: () => Promise<ServerBrowserState | null>;
  readonly reload: () => Promise<ServerBrowserState | null>;
  readonly stop: () => Promise<ServerBrowserState | null>;
  /** Resolves to the state after the tab opened (its active tab is the new one), or null on failure. */
  readonly newTab: () => Promise<ServerBrowserState | null>;
  readonly selectTab: (tabId: string) => Promise<ServerBrowserState | null>;
  readonly closeTab: (tabId: string) => Promise<ServerBrowserState | null>;
  readonly setViewport: (viewport: { mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number }) => Promise<ServerBrowserState | null>;
  readonly setZoom: (level: number) => Promise<ServerBrowserState | null>;
  readonly setColorScheme: (scheme: 'system' | 'light' | 'dark') => Promise<ServerBrowserState | null>;
  readonly setDevTools: (open: boolean) => Promise<ServerBrowserState | null>;
  readonly clearData: (what: 'cookies' | 'cache') => Promise<ServerBrowserState | null>;
  readonly selectScope: (scopeId: string) => Promise<ServerBrowserState | null>;
  readonly closeScope: (scopeId: string) => Promise<ServerBrowserState | null>;
  readonly evaluate: (expression: string, userGesture?: boolean) => Promise<unknown>;
  readonly capture: () => Promise<ServerBrowserCapture | null>;
  /** Resolve to null when the answer was refused (the dialog or request is gone, someone else is in control). */
  readonly answerDialog: (answer: { tabId: string; dialogId: number; accept: boolean; promptText?: string }) => Promise<ServerBrowserState | null>;
  readonly answerFileChooser: (answer: { tabId: string; chooserId: number; files: readonly string[] | null }) => Promise<ServerBrowserState | null>;
  readonly answerProfileRequest: (approve: boolean) => Promise<ServerBrowserState | null>;
};
