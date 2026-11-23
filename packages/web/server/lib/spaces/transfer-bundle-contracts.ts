import type { HostGit } from './code-transfer.js';
import type { RunCommand } from './command-contracts.js';
import type { parseSnapshotMetadata, transferCaps } from './transfer-bundle.js';

export interface TransferQueryParameters {
  directory: string;
  source: string;
  [key: string]: string;
}

export type TransferCaps = Readonly<ReturnType<typeof transferCaps>>;
export type SnapshotMetadata = ReturnType<typeof parseSnapshotMetadata>;
export interface BundleDirectoryOptions {
  readonly caps: Pick<TransferCaps, 'timeoutMs'>;
  readonly temporaryDirectory?: string | undefined;
  readonly trust?: readonly string[];
  readonly runCommand?: RunCommand | undefined;
  readonly gitPath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}
export interface BundleDirectory {
  readonly directory: string;
  readonly git: HostGit;
}
export interface BundleExpectation {
  readonly caps: TransferCaps;
  readonly objectFormat: string;
  readonly id: string;
  readonly ref: string;
  readonly prerequisite?: string;
}
export interface ResultBundleRequest {
  readonly caps: TransferCaps;
  readonly objectFormat: string;
  readonly spaceId: string;
  readonly result: string;
  readonly start: string;
}
