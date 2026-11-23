import type { AttachMode, GuestCapability, OpenChamberManifest, PublicSocketBinding } from '@openchamber/sdk';
import type { GitOrigin } from './persist.js';
import type { CapabilityScope } from './persist.js';
import type { resolveLoopbackTarget } from './loopback-target.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type GuestPackage = Partial<Omit<OpenChamberManifest['contributes'], 'panel' | 'background' | 'page' | 'attach' | 'statusSection'>> & {
  id: string;
  name: string;
  icon: string;
  packageRoot: string;
  entry?: string;
  entryDock?: NonNullable<OpenChamberManifest['contributes']['panel']['dock']>;
  entrySize?: number;
  panelBadge?: OpenChamberManifest['contributes']['panel']['badge'];
  entryMobile?: true;
  backgroundEntry?: string;
  backgroundStart?: NonNullable<OpenChamberManifest['contributes']['background']>['start'];
  version?: string;
  engines?: OpenChamberManifest['engines'];
  attach?: AttachMode;
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
  statusKeepAlive?: true;
};

export type GuestRecord = GuestPackage & {
  source?: string;
  path?: string | null;
  enabled?: boolean;
  capabilityGrants?: GuestCapability[];
  capabilityScope?: CapabilityScope | undefined;
  loopbackTarget?: ReturnType<typeof resolveLoopbackTarget>;
  gitOrigin?: GitOrigin | undefined;
  socketBindings?: PublicSocketBinding[] | undefined;
  revision?: number;
  storageId?: unknown;
  enterpriseBlocked?: GuestCapability[];
  folders?: string[] | undefined;
  update?: { version: string };
};
