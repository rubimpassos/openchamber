import type {
  AttachContribution,
  BackgroundContribution,
  FileEditorContribution,
  GuestActionContribution,
  GuestBlockContribution,
  GuestCapability,
  GuestCommandContribution,
  GuestGoalContribution,
  GuestMessageContribution,
  GuestPlanProviderContribution,
  GuestLinkAction,
  GuestSurfaceDock,
  GuestToolContribution,
  LoopbackContribution,
  PanelContribution,
  PublicService,
  PublicGuestCapabilities,
  PublicIntegration,
  PublicNotifications,
  PublicQuota,
  PublicTracker,
  PublicSessionEvents,
  PublicSourceControl,
  PublicWait,
} from '@openchamber/sdk';

export type GuestSource = 'bundled' | 'path' | 'zip' | 'git';

/** Public server resolution. Invalid overrides never expose their raw value. */
export type PublicLoopback = LoopbackContribution & (
  | { readonly status: 'ready'; readonly resolvedPort: number }
  | { readonly status: 'config-invalid'; readonly resolvedPort?: never }
);

export type InstalledGuest = {
  id: string;
  storageId?: string;
  name: string;
  icon: string;
  entry?: string;
  entryDock?: GuestSurfaceDock;
  entrySize?: number;
  readonly panelBadge?: PanelContribution['badge'];
  entryMobile?: true;
  backgroundEntry?: string;
  readonly backgroundStart?: BackgroundContribution['start'];
  version?: string;
  revision?: number;
  attach?: AttachContribution;
  attachEntry?: string;
  pageEntry?: string;
  pageTitle?: string;
  pageMobile?: true;
  statusEntry?: string;
  statusSource?: { path: string; interval: number };
  statusTitle?: string;
  statusHeight?: number;
  statusDefaultExpanded?: boolean;
  statusRequiresProject?: boolean;
  /** Keep the status frame running, hidden, while the section is folded. */
  statusKeepAlive?: true;
  integration?: PublicIntegration;
  filesystem?: string[];
  origins?: string[];
  service?: PublicService;
  readonly loopback?: PublicLoopback;
  sourceControl?: PublicSourceControl;
  sessionEvents?: PublicSessionEvents;
  waits?: Array<Pick<PublicWait, 'id' | 'title'>>;
  notifications?: PublicNotifications;
  tracker?: PublicTracker;
  quota?: PublicQuota;
  sessionControl?: { content: boolean };
  instructions?: true;
  marks?: true;
  skills?: true;
  opencodePlugin?: true;
  providerLogos?: Record<string, string>;
  mentions?: { label: string };
  links?: PublicGuestLinks;
  needsConfiguration?: string;
  blocks?: GuestBlockContribution[];
  actions?: GuestActionContribution[];
  commands?: GuestCommandContribution[];
  tools?: GuestToolContribution[];
  /** Declared `contributes.messages`; the chat applies them only for an active guest. */
  messages?: GuestMessageContribution[];
  /** Declared `contributes.goal`: the goal driver this extension's plugin is. */
  goal?: GuestGoalContribution;
  toolLinkSettings?: Record<string, string>;
  fileEditors?: FileEditorContribution[];
  /** Declared `contributes.plans`; the Plans area shows them only for an active guest. */
  plans?: GuestPlanProviderContribution[];
  capabilities: PublicGuestCapabilities;
  enterpriseBlocked?: GuestCapability[];
  source?: GuestSource;
  path?: string | null;
  enabled?: boolean;
  folders?: string[];
  origin?: GuestGitOrigin;
  update?: GuestUpdate;
};

export type UnreadableGuest = { id: string | null; name: string | null; builtIn: boolean };

export type OpenCodePluginDeliveryState = 'file' | 'restart' | 'none' | 'remote';

export type OpenCodePlugins = {
  delivery: OpenCodePluginDeliveryState;
  globalConfigPath: string | null;
  inGlobalConfig: string[];
};

export type PublicGuestLinks = {
  action: GuestLinkAction;
  keys: string[];
  urls: {
    origin: string;
    identifierPattern: string;
    patterns: Array<{ path: string; query?: { name: string } }>;
    itemTemplate: string | null;
  } | null;
};

export type GuestCatalog = { guests: InstalledGuest[]; unreadable: UnreadableGuest[]; opencodePlugins: OpenCodePlugins | null };

export type GuestGitOrigin = { url: string; ref?: string };

export type GuestUpdate = { version: string };
