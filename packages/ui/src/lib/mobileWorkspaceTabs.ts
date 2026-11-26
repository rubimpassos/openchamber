import { isCapacitorApp } from '@/lib/platform';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { isPluginContextPanelMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';

const ALL_BUILT_IN_MOBILE_WORKSPACE_TABS = ['status', 'changes', 'files', 'terminal', 'preview', 'notes'] as const;

export type BuiltInMobileWorkspaceTab = (typeof ALL_BUILT_IN_MOBILE_WORKSPACE_TABS)[number];

export type OfferedMobileWorkspaceTab = PluginContextPanelMode | 'preview';

const builtInMobileWorkspaceTabs = (offered: readonly OfferedMobileWorkspaceTab[]): readonly BuiltInMobileWorkspaceTab[] => (
  isCapacitorApp() || offered.includes('preview')
    ? ALL_BUILT_IN_MOBILE_WORKSPACE_TABS
    : ALL_BUILT_IN_MOBILE_WORKSPACE_TABS.filter((id) => id !== 'preview')
);
export type MobileWorkspaceTab = OrderedMobileWorkspaceTab | 'pages';

type OrderedMobileWorkspaceTab = BuiltInMobileWorkspaceTab | PluginContextPanelMode;

const NO_EXTENSION_TABS: readonly OfferedMobileWorkspaceTab[] = [];

const IN_APP_BROWSER_PROVIDER = 'builtin';

export const offeredMobileWorkspaceTabs = (
  extensions: readonly PluginContextPanelMode[],
  browserProvider: string,
): readonly OfferedMobileWorkspaceTab[] => (
  isMobileSurfaceRuntime() && browserProvider && browserProvider !== IN_APP_BROWSER_PROVIDER ? [...extensions, 'preview'] : extensions
);

export const orderMobileWorkspaceTabs = (
  order: readonly string[],
  extensions: readonly OfferedMobileWorkspaceTab[] = NO_EXTENSION_TABS,
): OrderedMobileWorkspaceTab[] => {
  const builtIns = builtInMobileWorkspaceTabs(extensions);
  const known = (id: string): id is OrderedMobileWorkspaceTab => builtIns.some((builtIn) => builtIn === id)
    || (isPluginContextPanelMode(id) && extensions.includes(id));
  const ordered = order.filter(known).filter((id, index, all) => all.indexOf(id) === index);
  builtIns.forEach((id, index) => {
    if (ordered.includes(id)) return;
    const followers = builtIns.slice(index + 1)
      .map((next) => ordered.indexOf(next))
      .filter((position) => position >= 0);
    ordered.splice(followers.length > 0 ? Math.min(...followers) : ordered.length, 0, id);
  });
  for (const id of extensions) {
    if (id !== 'preview' && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
};

export const storedMobileWorkspaceTabOrder = (order: readonly string[], previous: readonly string[]): string[] => {
  const extensionsIn = (ids: readonly string[]) => ids.filter((id): id is OfferedMobileWorkspaceTab => isPluginContextPanelMode(id) || id === 'preview');
  const next: string[] = orderMobileWorkspaceTabs(order, extensionsIn(order));
  const absent = new Set(extensionsIn(previous).filter((id) => !next.includes(id)));
  if (absent.size === 0) return next;
  const following = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of previous) {
    if (next.includes(id)) anchor = id;
    else if (isPluginContextPanelMode(id) && absent.delete(id)) following.set(anchor, [...(following.get(anchor) ?? []), id]);
  }
  return [...(following.get(null) ?? []), ...next.flatMap((id) => [id, ...(following.get(id) ?? [])])];
};

export const shownMobileWorkspaceTabs = (
  order: readonly string[],
  hidden: readonly string[],
  extensions: readonly OfferedMobileWorkspaceTab[] = NO_EXTENSION_TABS,
): OrderedMobileWorkspaceTab[] => {
  const all = orderMobileWorkspaceTabs(order, extensions);
  const shown = all.filter((id) => !hidden.includes(id));
  return shown.length > 0 ? shown : all;
};

export const stripMobileWorkspaceTabs = (
  order: readonly string[],
  hidden: readonly string[],
  active: MobileWorkspaceTab,
  extensions: readonly OfferedMobileWorkspaceTab[] = NO_EXTENSION_TABS,
): MobileWorkspaceTab[] => {
  const shown = shownMobileWorkspaceTabs(order, hidden, extensions);
  if (shown.some((id) => id === active)) return shown;
  return orderMobileWorkspaceTabs(order, extensions).filter((id) => id === active || shown.includes(id));
};

export const withReceivedPagesTab = (tabs: readonly MobileWorkspaceTab[]): MobileWorkspaceTab[] => {
  const next: MobileWorkspaceTab[] = tabs.filter((id) => id !== 'pages');
  next.splice(next.indexOf('status') + 1, 0, 'pages');
  return next;
};

export type MobileWorkspaceRequest =
  | { tab: Exclude<MobileWorkspaceTab, 'changes'> }
  | { tab: 'changes'; commit?: { directory: string } };

type MobileWorkspaceOpener = (request: MobileWorkspaceRequest) => void;

let workspaceOpener: MobileWorkspaceOpener | null = null;

export const connectMobileWorkspaceOpener = (opener: MobileWorkspaceOpener): (() => void) => {
  workspaceOpener = opener;
  return () => {
    if (workspaceOpener === opener) workspaceOpener = null;
  };
};

export const openMobileWorkspace = (request: MobileWorkspaceRequest): boolean => {
  if (!workspaceOpener) return false;
  workspaceOpener(request);
  return true;
};
