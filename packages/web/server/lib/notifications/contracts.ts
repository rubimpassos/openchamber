export type { SessionMetadata as StoredSessionMetadata } from '../openchamber-sessions/session-metadata-store.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

export interface SessionRecords {
  [session: string]: JsonValue | undefined;
}

export type PushSettings = {
  vapidKeys?: unknown;
  publicOrigin?: unknown;
};

export interface NotificationPayload {
  title?: string;
  body?: string | undefined;
  tag?: string | undefined;
  kind?: string;
  sessionId?: string | null | undefined;
  directory?: string | null | undefined;
  requireHidden?: boolean;
  showWhenFocused?: boolean;
  toastOnly?: boolean;
  skipTurnStart?: boolean;
  botTarget?: { readonly projectId: string; readonly itemId: string };
}

export interface NotificationUiEvent {
  type: 'openchamber:notification';
  properties: NotificationPayload & {
    desktopNotificationDelivered: boolean;
    desktopStdoutActive: boolean;
  };
}

export interface SseWriter {
  write: (chunk: string) => void;
}
