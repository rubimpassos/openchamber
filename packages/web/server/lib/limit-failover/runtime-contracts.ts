import type { FailoverModel } from './policy.js';
import type { Request } from '../shared/http-contracts.js';

export type LimitFailoverAnnouncement = {
  kind: 'account';
  sessionId: string;
  providerId: string;
  fromAccount: string | null;
  toAccount: string;
} | {
  kind: 'model';
  sessionId: string;
  providerId: string;
  modelId: string;
  toProviderId: string;
  toModelId: string;
};

export type LimitFailoverDecision =
  | { action: 'none' }
  | { action: 'retry' }
  | { action: 'fail' }
  | { action: 'wait'; delay: number }
  | { action: 'activate-credential'; credentialID: string; ticket?: string }
  | { action: 'switch-model'; model: FailoverModel; ticket: string };

export interface LimitFailoverDependencies {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  instanceDir: string;
  dataDir?: string | null;
  readSettings: () => Promise<StoredFailoverSettings | null>;
  authorizeRequest: (req: Request) => boolean;
  broadcastUiEvent?: (event: { type: 'openchamber:limit-failover'; properties: LimitFailoverAnnouncement }) => void;
  now?: () => number;
}

export interface StoredFailoverSettings {
  accountSwitchProviders?: unknown;
  fallbackModel?: unknown;
  fallbackVariant?: unknown;
}
