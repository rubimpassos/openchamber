import type { createBotEffects } from '../effects.js';
import type { BotExecutionEntry } from '../execution-store.js';
import type { BotItem } from '../schema.js';
import type { RuntimeOptions } from './contracts.js';
import type { createRuntimeItemState } from './item-state.js';
import type { createRuntimeJournal } from './journal.js';
import type { createRuntimeProjectOwner } from './project-owner.js';

type JournalValue = BotExecutionEntry['data'][string];

export type RuntimeContext = Readonly<Pick<RuntimeOptions, 'config' | 'store' | 'resolveProject' | 'listProjects' | 'stages' | 'worktrees' | 'services'
  | 'serviceContext' | 'runProof' | 'pullRequests' | 'sources' | 'attention' | 'notices' | 'questions' | 'events' | 'presentedArtifacts'>
  & ReturnType<typeof createRuntimeItemState> & {
    readonly readPolicy: NonNullable<RuntimeOptions['readPolicy']>;
    readonly now: () => number;
    readonly journal: ReturnType<typeof createRuntimeJournal>;
    readonly effects: ReturnType<typeof createBotEffects>;
    readonly ownProject: ReturnType<typeof createRuntimeProjectOwner>;
    readonly dirty: Set<string>;
    readonly activeProofs: Map<string, AbortController>;
    readonly isStopped: () => boolean;
  }>;

export type RuntimeDetail = {
  readonly item: BotItem;
  readonly reports: NonNullable<JournalValue>;
  readonly snapshot: JournalValue;
  readonly questionKey?: string | undefined;
};
export type RuntimePump = (projectId: string) => Promise<void>;
export type RuntimeDetailReader = (projectId: string, itemId: string) => Promise<RuntimeDetail>;
