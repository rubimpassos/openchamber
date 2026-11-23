import type { HostAccount } from './accounts.js';
import type { AccessReport, BotWorktreeMapping, GrantOptions } from './bot-migration-access.types.js';
import type { JsonValue } from './host-inputs.js';
import type { readBotItem } from './migration-records.js';

export type MigrationValue = Exclude<Parameters<typeof readBotItem>[0], undefined>;
export type MigrationObject = { readonly [key: string]: MigrationValue | undefined };

export type MigrationAccount = Pick<HostAccount, 'uid' | 'gid' | 'home'>;
export type PendingMigrationAccount = Pick<HostAccount, 'home'> & { readonly uid?: undefined; readonly gid?: undefined };
export type MigrationSystem = {
  chown(file: string, uid: number, gid: number): Promise<void>;
  isActive(unit: string): Promise<string>;
  readonly runResult: GrantOptions['run'];
};
export type MigrationClass = 'skipped' | 'agent' | 'front-door' | 'unclassified' | 'agent-settings' | 'opencode';
export type MigrationFile = {
  readonly source: string; readonly target: string | null; readonly class: MigrationClass;
  status: 'planned' | 'copied' | 'existing' | 'skipped' | 'cycle-skipped' | 'special-skipped' | 'foreign-skipped' | 'conflict' | 'blocked';
  readonly code?: string;
};
export type RefusedProject = { readonly path: string; readonly status: 'refused'; readonly code: string | undefined; readonly message: string | undefined };
export type ProjectSharing<Result = JsonValue> = { share(directory: string): Promise<Result> };
export type MigrationManifest<Result = JsonValue> = {
  readonly version: 1; readonly files: MigrationFile[]; worktrees: string[];
  projects: (Result | RefusedProject)[];
  blockedProjects: { readonly stem: string; readonly code: string }[];
  botWorktrees?: readonly BotWorktreeMapping[];
  botWorktreeAccess?: AccessReport | { readonly status: 'refused'; readonly changed: readonly [] };
};
type MigrationMode =
  | { readonly dryRun: true; readonly front: MigrationAccount | PendingMigrationAccount; readonly agent: MigrationAccount | PendingMigrationAccount }
  | { readonly dryRun: false; readonly front: MigrationAccount; readonly agent: MigrationAccount };
export type MigrationContext = MigrationMode & {
  readonly root: string; readonly source: string; readonly botRoot: string; readonly frontData: string; readonly agentData: string;
  readonly owner: MigrationAccount; readonly system: MigrationSystem;
  readonly manifest: Pick<MigrationManifest, 'files' | 'blockedProjects' | 'botWorktrees' | 'botWorktreeAccess'>;
  readonly trustedBotWorktrees: readonly BotWorktreeMapping[];
};
type AccountInput =
  | { readonly dryRun: true; readonly accounts: { readonly human: MigrationAccount; readonly front: MigrationAccount | PendingMigrationAccount; readonly agent: MigrationAccount | PendingMigrationAccount } }
  | { readonly dryRun?: false | undefined; readonly accounts: { readonly human: MigrationAccount; readonly front: MigrationAccount; readonly agent: MigrationAccount } };
export type MigrateAccountsOptions<Result = JsonValue> = AccountInput & {
  readonly root?: string; readonly system: MigrationSystem; readonly envFile: string;
  readonly sharing?: ProjectSharing<Result> | undefined; readonly trustedBotWorktrees?: readonly BotWorktreeMapping[];
  readonly say?: (message: string) => void;
};
export type CopyDestination = {
  readonly source: string; readonly target: string; readonly account: 'front' | 'agent'; readonly kind: MigrationClass;
  readonly filter?: ((name: string) => boolean) | null | undefined; readonly ancestors?: readonly string[];
  readonly strict?: boolean;
};
export type SplitDestination = Pick<CopyDestination, 'source' | 'target' | 'account' | 'kind'> & { readonly value: MigrationValue };
