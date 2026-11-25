import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { toPublicAttachment } from './attachments.js';
import type { PublicQueuedAttachment } from './attachments.js';
import type { QueuedItem, SessionQueue } from './runtime.js';

export interface PublicQueuedItem extends Omit<QueuedItem, 'context' | 'syntheticIds' | 'attachments'> {
  attachments: PublicQueuedAttachment[];
}
export interface MessageQueueSessionSnapshot {
  readonly queueOwner?: 'bot-conversation';
  sessionId: string;
  directory: string;
  items: PublicQueuedItem[];
  sendingId: string | null;
}
type QueueSnapshotSource = {
  readonly queues: ReadonlyMap<string, SessionQueue>;
  readonly directories: ReadonlyMap<string, string | undefined>;
  readonly sending: ReadonlyMap<string, string>;
  readonly queueOwner: 'bot-conversation' | undefined;
};

const toPublicItem = (item: QueuedItem) => {
  const publicItem: Omit<PublicQueuedItem, 'attachments' | 'sendConfig'> & Partial<Pick<PublicQueuedItem, 'attachments' | 'sendConfig'>> = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => {
      const context = part.metadata?.openchamberContext;
      return asNonEmptyString(isRecord(context) ? context.text : undefined) || part.text.trim();
    })
    .find(Boolean);
  if (contextPreview) {
    const [firstLine = ''] = contextPreview.split('\n', 1);
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  if (item.goal) publicItem.goal = { ...item.goal };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
  if (item.origin) publicItem.origin = { ...item.origin };
  return Object.assign(publicItem, { attachments: publicItem.attachments, sendConfig: publicItem.sendConfig });
};

export function createQueueSessionSnapshot(source: QueueSnapshotSource) {
  return (sessionId: string): MessageQueueSessionSnapshot => {
    const queue = source.queues.get(sessionId);
    const snapshot: MessageQueueSessionSnapshot = {
      sessionId, directory: queue?.directory ?? source.directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: source.sending.get(sessionId) ?? null,
    };
    if (source.queueOwner) return { ...snapshot, queueOwner: source.queueOwner };
    return snapshot;
  };
}
