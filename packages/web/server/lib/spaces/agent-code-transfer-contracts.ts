import type { AgentTransferOptions, BringRequest, CodeInOptions, CodeTransferPlace, HistoryRequest, HistoryResult, SnapshotResult, TransferOwner } from './code-in.js';
import type { CodeOutOptions, CodeOutPlace, CodeOutRequest, CodeOutSummary } from './code-out-contracts.js';
import type { BundleDirectory, SnapshotMetadata } from './transfer-bundle-contracts.js';

export interface AgentBundleOptions extends AgentTransferOptions {
  readonly place: CodeTransferPlace | CodeOutPlace | null;
  readonly temporaryDirectory?: string | undefined;
}
export interface CodeInArrival extends Pick<SnapshotResult, 'base' | 'staged' | 'start' | 'branch' | 'objectFormat'> {
  readonly spacePath: string;
  readonly projectPath: string;
  readonly identityCopied: { readonly name: boolean; readonly email: boolean };
}
export type AgentCodeInOptions = CodeInOptions & {
  readonly localCodeIn: (options: CodeInOptions) => {
    readonly bringCodeIn: (input: BringRequest) => Promise<CodeInArrival>;
    readonly sendHistory: (input: HistoryRequest) => Promise<HistoryResult>;
  };
};
export type AgentCodeOutOptions = CodeOutOptions & {
  readonly localCodeOut: (options: CodeOutOptions) => {
    readonly bringCodeOut: (input: CodeOutRequest) => Promise<CodeOutSummary>;
  };
};
export interface TransferRequest extends TransferOwner {
  readonly repository: string;
  readonly spaceId: string;
  readonly base?: string;
  readonly mode?: string;
}
export type TransferSourceRequest = Omit<TransferRequest, 'spaceId'> & { readonly spaceId?: string };
export interface TransferJsonOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly extra?: Readonly<Record<string, string>> | undefined;
}
export interface TransferMirror extends BundleDirectory {
  readonly repository: string;
  readonly place: CodeTransferPlace | CodeOutPlace | null;
  readonly taken: SnapshotMetadata;
}
