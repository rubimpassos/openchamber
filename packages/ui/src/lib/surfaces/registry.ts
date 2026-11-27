import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import {
  isPluginContextPanelMode,
  type ContextPanelMode,
} from '@/lib/surfaces/modes';

type BuiltInContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'notes'
  | 'context'
  | 'browser'
  | 'workflows'
  | 'subagents'
  | 'chat'
  | 'pages'
  | 'bot';

export type ContextSurfaceId = BuiltInContextSurfaceId | `plugin:${string}`;

export type ContextSurfaceWidth = {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
};

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  mode: ContextPanelMode;
  icon: IconName;
  iconSrc?: string;
  label?: string;
  labelKey: I18nKey;
  availability: 'always' | 'has-content';
  descriptionKey: I18nKey;
  width?: ContextSurfaceWidth;
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    descriptionKey: 'contextRail.surface.context.description',
    mode: 'context',
    icon: 'pie-chart',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'git',
    descriptionKey: 'contextRail.surface.git.description',
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'pr',
    descriptionKey: 'contextRail.surface.pr.description',
    mode: 'pr',
    icon: 'github',
    labelKey: 'contextPanel.mode.pr',
    availability: 'always',
  },
  {
    id: 'diff',
    descriptionKey: 'contextRail.surface.diff.description',
    mode: 'diff',
    icon: 'layout-column',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'walkthrough',
    descriptionKey: 'contextRail.surface.walkthrough.description',
    mode: 'walkthrough',
    icon: 'route',
    labelKey: 'contextPanel.mode.walkthrough',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    mode: 'file',
    icon: 'file-edit',
    labelKey: 'contextPanel.mode.files',
    availability: 'always',
  },
  {
    id: 'terminal',
    descriptionKey: 'contextRail.surface.terminal.description',
    mode: 'terminal',
    icon: 'terminal-box',
    labelKey: 'layout.mainTab.terminal',
    availability: 'always',
  },
  {
    id: 'browser',
    descriptionKey: 'contextRail.surface.browser.description',
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'notes',
    descriptionKey: 'contextRail.surface.notes.description',
    mode: 'notes',
    icon: 'book-marked',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'workflows',
    descriptionKey: 'contextRail.surface.workflows.description',
    mode: 'workflows',
    icon: 'flow-chart',
    labelKey: 'contextPanel.mode.workflows',
    availability: 'always',
  },
  {
    id: 'subagents',
    descriptionKey: 'contextRail.surface.subagents.description',
    mode: 'subagents',
    icon: 'ai-agent',
    labelKey: 'contextPanel.mode.subagents',
    availability: 'has-content',
  },
  {
    id: 'chat',
    descriptionKey: 'contextRail.surface.chat.description',
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
  },
  {
    id: 'pages',
    descriptionKey: 'contextRail.surface.pages.description',
    mode: 'pages',
    icon: 'pages',
    labelKey: 'contextPanel.mode.pages',
    availability: 'has-content',
  },
  {
    id: 'bot',
    descriptionKey: 'bots.panel.description',
    mode: 'bot',
    icon: 'robot-2',
    labelKey: 'bots.panel.title',
    availability: 'has-content',
    width: { defaultWidth: 340, minWidth: 300, maxWidth: 480 },
  },
];

const DECLARED_WIDTHS = new Map(CONTEXT_SURFACES.flatMap((surface) => (surface.width ? [[surface.mode, surface.width] as const] : [])));

export const declaredSurfaceWidth = (mode: ContextPanelMode): ContextSurfaceWidth | null => DECLARED_WIDTHS.get(mode) ?? null;

export const clampSurfaceWidth = (limits: ContextSurfaceWidth, width: number): number => (
  Number.isFinite(width) ? Math.min(limits.maxWidth, Math.max(limits.minWidth, Math.round(width))) : limits.defaultWidth
);

export const WALKTHROUGH_MIN_WIDTH = 768;

type ContextSurfaceGroup = 'context' | 'changes' | 'tools' | 'workspace' | 'extensions';

const BUILT_IN_SURFACE_GROUPS = {
  context: 'context',
  git: 'changes',
  pr: 'changes',
  diff: 'changes',
  walkthrough: 'changes',
  editor: 'tools',
  terminal: 'tools',
  browser: 'tools',
  notes: 'workspace',
  workflows: 'workspace',
  subagents: 'workspace',
  chat: 'workspace',
  pages: 'workspace',
  bot: 'workspace',
} satisfies Record<BuiltInContextSurfaceId, ContextSurfaceGroup>;

const isBuiltInSurfaceId = (id: ContextSurfaceId): id is BuiltInContextSurfaceId => Object.hasOwn(BUILT_IN_SURFACE_GROUPS, id);

export const contextSurfaceGroup = (surface: Pick<ContextSurfaceDescriptor, 'id' | 'mode'>): ContextSurfaceGroup => (
  !isPluginContextPanelMode(surface.mode) && isBuiltInSurfaceId(surface.id)
    ? BUILT_IN_SURFACE_GROUPS[surface.id]
    : 'extensions'
);

const isKnownSurfaceId = (value: string, byId: ReadonlyMap<string, ContextSurfaceDescriptor>): boolean => {
  return byId.has(value);
};

export const sortContextSurfaces = (
  railOrder: readonly string[],
  extras: readonly ContextSurfaceDescriptor[] = [],
): ContextSurfaceDescriptor[] => {
  const all = extras.length === 0 ? CONTEXT_SURFACES : [...CONTEXT_SURFACES, ...extras];
  const byId = new Map<string, ContextSurfaceDescriptor>(all.map((surface) => [surface.id, surface]));
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<string>();

  for (const id of railOrder) {
    if (!isKnownSurfaceId(id, byId) || seen.has(id)) {
      continue;
    }
    const surface = byId.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of all) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  const groupOrder: ContextSurfaceGroup[] = [];
  for (const surface of ordered) {
    const group = contextSurfaceGroup(surface);
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }
  return groupOrder.flatMap((group) => ordered.filter((surface) => contextSurfaceGroup(surface) === group));
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  hiddenSurfaces?: readonly string[];
  isVSCode: boolean;
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode; targetPath?: string | null }[];
  sourceControlConnected: boolean;
  workflowsShown: boolean;
  receivedPagesShown?: boolean;
  extras?: readonly ContextSurfaceDescriptor[];
};

export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder, options.extras).filter((surface) => {
    if (options.hiddenSurfaces?.includes(surface.id)) {
      return false;
    }
    if (isPluginContextPanelMode(surface.mode) && options.isVSCode) {
      return false;
    }
    if (surface.id === 'walkthrough' && (options.isVSCode || options.screenWidth < WALKTHROUGH_MIN_WIDTH)) {
      return false;
    }
    if (surface.id === 'browser' && options.isVSCode) {
      return false;
    }
    if (surface.id === 'pr' && !options.sourceControlConnected
      && !options.tabs.some((tab) => tab.mode === 'pr' && tab.targetPath)) {
      return false;
    }
    if (surface.id === 'workflows' && (options.isVSCode || !options.workflowsShown)) {
      return false;
    }
    if (surface.id === 'pages' && options.receivedPagesShown) {
      return true;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
