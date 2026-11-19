import { create } from 'zustand';

import type { ServerBrowserScope, ServerBrowserState } from './types';

/**
 * Which Chrome tab on the server each Browser panel tab shows.
 *
 * In server mode a panel tab is a window onto one tab of the chat's Chrome:
 * `+` opens a panel tab and a Chrome tab together, and closing the panel tab
 * closes its Chrome tab. Keyed by scope (one Chrome per chat) and panel tab id,
 * since the same panel tabs follow the user from chat to chat in a directory.
 *
 * In memory only: after a reload each panel tab claims the next unclaimed
 * Chrome tab again, which is the same pairing for the usual one-to-one case.
 */
type PanelTabClaims = {
  readonly claims: Readonly<Record<string, string>>;
  readonly failedNavigations: ReadonlySet<string>;
  claim: (scopeId: string, panelTabId: string, chromeTabId: string) => void;
  release: (scopeId: string, panelTabId: string) => void;
  setNavigationFailed: (scopeId: string, chromeTabId: string, failed: boolean) => void;
};

const claimKey = (scopeId: string, panelTabId: string): string => `${scopeId}\u0000${panelTabId}`;

export const useServerBrowserPanelTabs = create<PanelTabClaims>((set) => ({
  claims: {},
  failedNavigations: new Set(),
  setNavigationFailed: (scopeId, chromeTabId, failed) => set((state) => {
    // A navigation may finish after its panel tab closed and released the claim.
    if (!panelTabsByChromeTab(state.claims, scopeId).has(chromeTabId)) return state;
    const key = claimKey(scopeId, chromeTabId);
    if (state.failedNavigations.has(key) === failed) return state;
    const next = new Set(state.failedNavigations);
    if (failed) next.add(key);
    else next.delete(key);
    return { failedNavigations: next };
  }),
  claim: (scopeId, panelTabId, chromeTabId) => set((state) => ({
    claims: { ...state.claims, [claimKey(scopeId, panelTabId)]: chromeTabId },
  })),
  release: (scopeId, panelTabId) => set((state) => {
    const key = claimKey(scopeId, panelTabId);
    if (!(key in state.claims)) return state;
    const next = { ...state.claims };
    const failedNavigations = new Set(state.failedNavigations);
    failedNavigations.delete(claimKey(scopeId, next[key]));
    delete next[key];
    return { claims: next, failedNavigations };
  }),
}));

export const claimedChromeTab = (
  claims: Readonly<Record<string, string>>,
  scopeId: string,
  panelTabId: string,
): string | null => claims[claimKey(scopeId, panelTabId)] ?? null;

export const hasFailedPanelNavigation = (scopeId: string, chromeTabId: string): boolean => (
  useServerBrowserPanelTabs.getState().failedNavigations.has(claimKey(scopeId, chromeTabId))
);

/** Chrome tabs of a scope that no panel tab shows yet. */
export const unclaimedChromeTabs = (
  claims: Readonly<Record<string, string>>,
  scope: ServerBrowserScope,
): string[] => {
  const prefix = `${scope.id}\u0000`;
  const taken = new Set(Object.entries(claims)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, tabId]) => tabId));
  return scope.tabs.map((tab) => tab.id).filter((id) => !taken.has(id));
};

/** Panel tab ids of a scope that point at a Chrome tab, keyed by that tab. */
export const panelTabsByChromeTab = (
  claims: Readonly<Record<string, string>>,
  scopeId: string,
): Map<string, string> => {
  const prefix = `${scopeId}\u0000`;
  const result = new Map<string, string>();
  for (const [key, tabId] of Object.entries(claims)) {
    if (key.startsWith(prefix)) result.set(tabId, key.slice(prefix.length));
  }
  return result;
};

/**
 * Panel tabs that showed a Chrome tab of the chat's browser after the service
 * closed that browser with its last tab (`emptiedSessions`): they close with
 * it. A panel tab opened after that holds no claim on the old browser, so it
 * gets a new one. The scope id is the service's (project, chat) key.
 */
export const emptiedChatPanelTabs = (
  state: ServerBrowserState | null,
  directory: string,
  sessionId: string | null,
): string[] => {
  if (!sessionId || !state?.emptiedSessions?.includes(sessionId)) return [];
  const scopeId = JSON.stringify([directory, sessionId]);
  if (state.scopes.some((scope) => scope.id === scopeId)) return [];
  return [...panelTabsByChromeTab(useServerBrowserPanelTabs.getState().claims, scopeId).values()];
};

/**
 * A profile being signed into from Settings. While set, the Browser panel
 * shows that profile's sign-in browser (instead of the chat's) with a bar to
 * save the sign-in or cancel it.
 */
type ProfileSignIn = { readonly profileId: string; readonly name: string };

type ProfileSignInStore = {
  readonly signIn: ProfileSignIn | null;
  setSignIn: (signIn: ProfileSignIn | null) => void;
};

export const useServerBrowserSignIn = create<ProfileSignInStore>((set) => ({
  signIn: null,
  setSignIn: (signIn) => set({ signIn }),
}));

/**
 * The Browser panel tab that shows the agent's tab of the chat on screen, so
 * the tab strip can mark it, and whether an agent action runs there now.
 * Set by the Server Browser view, which is the only one that knows the pairing.
 */
type AgentPanelTab = { readonly panelTabId: string; readonly acting: boolean };

type AgentPanelTabStore = {
  readonly agentTab: AgentPanelTab | null;
  setAgentTab: (agentTab: AgentPanelTab | null) => void;
};

export const useServerBrowserAgentTab = create<AgentPanelTabStore>((set) => ({
  agentTab: null,
  setAgentTab: (agentTab) => set((state) => (
    state.agentTab?.panelTabId === agentTab?.panelTabId && state.agentTab?.acting === agentTab?.acting ? state : { agentTab }
  )),
}));
