import { create } from 'zustand';

import { invokeDesktopCommand } from '@/lib/desktopNative';

const MAX_ORIGINS = 60;

type FaviconState = {
  byOrigin: Record<string, string>;
  resolve: (pageUrl: string, iconUrl: string, webContentsId: number) => void;
  /** Stores an icon already fetched elsewhere (the Server Browser sends data URLs). */
  put: (pageUrl: string, dataUrl: string) => void;
};

const originOf = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const pending = new Set<string>();

const withIcon = (current: FaviconState['byOrigin'], origin: string, dataUrl: string) => {
  const byOrigin = { ...current, [origin]: dataUrl };
  const origins = Object.keys(byOrigin);
  // Oldest first: insertion order is close enough to least-recently-seen
  // for a cache whose only cost is one request.
  for (const stale of origins.slice(0, Math.max(0, origins.length - MAX_ORIGINS))) delete byOrigin[stale];
  return byOrigin;
};

export const useBrowserFaviconStore = create<FaviconState>()((set, get) => ({
  byOrigin: {},

  resolve: (pageUrl, iconUrl, webContentsId) => {
    const origin = originOf(pageUrl);
    if (!origin || !iconUrl) return;
    if (get().byOrigin[origin] || pending.has(origin)) return;

    pending.add(origin);
    void invokeDesktopCommand<{ dataUrl?: string }>('desktop_browser_fetch_favicon', { url: iconUrl, webContentsId })
      .then((result) => {
        const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : '';
        if (!dataUrl) return;
        set((state) => ({ byOrigin: withIcon(state.byOrigin, origin, dataUrl) }));
      })
      .catch(() => undefined)
      .finally(() => { pending.delete(origin); });
  },

  put: (pageUrl, dataUrl) => {
    const origin = originOf(pageUrl);
    if (!origin || !dataUrl.startsWith('data:image/') || get().byOrigin[origin] === dataUrl) return;
    set((state) => ({ byOrigin: withIcon(state.byOrigin, origin, dataUrl) }));
  },
}));
