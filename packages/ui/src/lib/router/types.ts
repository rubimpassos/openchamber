import type { SidebarSection } from '@/constants/sidebar';
import { z } from 'zod';
import { isLinkIdentifier } from './messageFocus';

export type BotsRouteTarget = { readonly projectId: string; readonly itemId: string };
const linkId = z.string().refine(isLinkIdentifier);
export const botsRouteTargetSchema = z.object({ projectId: linkId, itemId: linkId }).strict();

export interface RouteState {
  sessionId: string | null;
  messageId: string | null;
  tab: RouteTab | null;
  settingsPath: string | null;
  diffFile: string | null;
  /** Guest id whose panel to reveal, from a `browser.requestHelp` push deep link */
  guestPanelId: string | null;
  /** Session-independent Bots item from a notification or shared link. */
  readonly botsTarget: BotsRouteTarget | null;
}

export type RouteTab = 'chat' | 'git' | 'diff' | 'terminal' | 'files';
export const VALID_TABS: readonly RouteTab[] = ['chat', 'git', 'diff', 'terminal', 'files'] as const;

export const VALID_SETTINGS_SECTIONS: readonly SidebarSection[] = [
  'settings',
  'agents',
  'commands',
  'skills',
  'providers',
  'usage',
  'git-identities',
] as const;

export const ROUTE_PARAMS = {
  SESSION: 'session',
  MESSAGE: 'message',
  TAB: 'tab',
  SETTINGS: 'settings',
  FILE: 'file',
  PANEL: 'panel',
  BOTS_PROJECT: 'botsProject',
  BOT_ITEM: 'botItem',
} as const;
