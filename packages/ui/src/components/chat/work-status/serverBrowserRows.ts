import type { IconName } from '@/components/icon/icons';
import type { MonitoredBrowser } from '@/lib/browser/serverBrowser/monitoredBrowsers';
import type { ServerBrowserMemory } from '@/lib/browser/serverBrowser/types';
import type { I18nKey } from '@/lib/i18n';

type BrowserRowStatus = 'needsYou' | 'working' | 'failed' | 'youControl' | 'otherControls' | 'loading' | 'idle';

export const browserRowStatus = (browser: MonitoredBrowser): BrowserRowStatus => {
  if (browser.helpReason !== null) return 'needsYou';
  if (browser.agentActive) return 'working';
  if (browser.lastError !== null) return 'failed';
  if (browser.control === 'viewer') return 'youControl';
  if (browser.control === 'other') return 'otherControls';
  return browser.loading ? 'loading' : 'idle';
};

type BrowserRowLook = { readonly icon: IconName; readonly color: string | null; readonly labelKey: I18nKey | null };

export const BROWSER_ROW_LOOK = {
  needsYou: { icon: 'alert', color: 'var(--status-warning)', labelKey: 'chat.workStatus.browsers.status.needsYou' },
  working: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workStatus.browsers.status.working' },
  failed: { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'chat.workStatus.browsers.status.failed' },
  youControl: { icon: 'user-3', color: null, labelKey: 'chat.workStatus.browsers.status.youControl' },
  otherControls: { icon: 'user-3', color: null, labelKey: 'chat.workStatus.browsers.status.otherControls' },
  loading: { icon: 'global', color: null, labelKey: 'chat.workStatus.browsers.status.loading' },
  idle: { icon: 'global', color: null, labelKey: null },
} satisfies Record<BrowserRowStatus, BrowserRowLook>;

export const orderBrowserRows = (
  browsers: readonly MonitoredBrowser[],
  currentSessionId: string | null,
): MonitoredBrowser[] => {
  const ofCurrentChat = (browser: MonitoredBrowser) => currentSessionId !== null && browser.sessionId === currentSessionId;
  return [...browsers.filter(ofCurrentChat), ...browsers.filter((browser) => !ofCurrentChat(browser))];
};

export const browserPage = (browser: MonitoredBrowser): string | null => {
  const title = browser.title.trim();
  if (title) return title;
  return browser.url && browser.url !== 'about:blank' ? browser.url : null;
};

export const totalBrowserMemory = (
  browsers: readonly MonitoredBrowser[],
  memory: ServerBrowserMemory | null,
): number | null => {
  if (!memory) return null;
  const measured = browsers.flatMap((browser) => memory.bytesByScope.get(browser.scopeId) ?? []);
  return measured.length > 0 ? measured.reduce((sum, bytes) => sum + bytes, 0) : null;
};

const MEGABYTE = 1024 ** 2;
const GIGABYTE = 1024 ** 3;

export const formatBrowserMemory = (bytes: number, locale: string): string => {
  if (bytes >= GIGABYTE) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / GIGABYTE)} GB`;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, Math.round(bytes / MEGABYTE)))} MB`;
};
