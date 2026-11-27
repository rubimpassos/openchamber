import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';

export const ACTIVITY_TITLE_KEY = {
  priority: 'sessions.sidebar.activity.priorityTitle',
  pages: 'sessions.sidebar.activity.pagesTitle',
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  chats: 'sessions.sidebar.activity.chatsTitle',
  bots: 'bots.sidebar.title',
  timeline: 'sessions.sidebar.activity.projectsTitle',
} as const;

export const isBuiltinActivityKey = (key: SessionSidebarActivityKey): key is keyof typeof ACTIVITY_TITLE_KEY => (
  Object.hasOwn(ACTIVITY_TITLE_KEY, key)
);
