import { readBrowserMemory } from './browser-memory.js';

export const SIGN_IN_PREFIX = 'profile:';
export const scopeId = ({ directory, sessionId }) => JSON.stringify([directory, sessionId]);
export const knownScope = (context) => (
  context
  && typeof context.directory === 'string'
  && context.directory.length > 0
  && typeof context.sessionId === 'string'
  && context.sessionId.length > 0
);

export const scopeState = (entry, selectedId, profileUsers) => ({
  id: entry.id,
  directory: entry.directory,
  sessionId: entry.sessionId,
  profile: entry.profile ? { ...entry.profile, copyVersion: entry.runtime.profileVersion ?? null, users: profileUsers(entry).length } : null,
  signIn: entry.directory.startsWith(SIGN_IN_PREFIX),
  selected: entry.id === selectedId,
  url: entry.runtime.url ?? 'about:blank',
  title: entry.runtime.title ?? '',
  isLoading: entry.runtime.isLoading === true,
  canGoBack: entry.runtime.canGoBack === true,
  canGoForward: entry.runtime.canGoForward === true,
  nativeSelectCompatibility: entry.runtime.nativeSelectCompatibility === true,
  nativeSelectCompatibilityError: entry.runtime.nativeSelectCompatibilityError ?? '',
  devtools: entry.runtime.devtools === true,
  tabs: entry.runtime.tabs ?? [],
  agentTabId: entry.runtime.agentTabId ?? null,
  agentActive: entry.runtime.agentActive === true,
  lastActivityAt: entry.lastActivityAt,
  lastError: entry.lastError,
  downloads: entry.runtime.downloads ?? [],
  audioUnavailable: entry.runtime.audioUnavailable === true,
  viewport: entry.runtime.viewportState ?? null,
  problems: entry.runtime.problemCounts ?? { errors: 0, warnings: 0 },
  zoomLevel: entry.runtime.zoomLevel ?? 0,
  colorScheme: entry.runtime.colorScheme ?? 'system',
});

export const scopeMemory = async (scopes, now) => {
  const entries = [...scopes.values()];
  const sampledAt = now();
  const bytes = await readBrowserMemory(entries.map((entry) => entry.runtime.browserProcess));
  return {
    sampledAt,
    scopes: entries.flatMap((entry, index) => scopes.get(entry.id) === entry ? [{
      scopeId: entry.id,
      memoryBytes: bytes[index],
    }] : []),
  };
};
