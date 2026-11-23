import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type BotWorktreeMapping = { readonly projectId: string; readonly itemId: string; readonly directory: string;
  readonly directoryIdentity: string; readonly gitDirectory: string; readonly gitIdentity: string };
export type ReadOptions = { readonly root?: string; readonly file?: unknown;
  readonly readIdentity?: ((handle: FileHandle) => Promise<BigIntStats>) | undefined };
export type Principal = { readonly uid: number; readonly gid: number; readonly gids?: readonly number[] | undefined };
type PendingPrincipal = { readonly uid?: undefined; readonly gid?: undefined; readonly gids?: readonly number[] };
export type ChangedAccess = { readonly path: string; readonly access: 'traverse' | 'tree' };
export type AccessReport = { readonly status: 'planned' | 'granted' | 'partial' | 'refused'; readonly trees: readonly string[];
  readonly changed: readonly ChangedAccess[]; readonly failed?: string };
export type GrantOptions = { readonly root?: string; readonly botRoot: string; readonly entries: readonly BotWorktreeMapping[];
  readonly human: { readonly uid: number; readonly home: string }; readonly agent: Principal | PendingPrincipal;
  readonly run: (command: string, args: string[]) => Promise<{ readonly code: number | null; readonly stdout: string }>;
  readonly dryRun?: boolean; readonly readMountInfo?: () => Promise<string> };
