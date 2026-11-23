import type { MetadataDecider, SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { OpenCode } from '@opencode/client';

export interface InterruptedTool {
  name: string;
  input?: string | null | undefined;
  callID?: string;
}

export interface PendingQuestion {
  readonly messageID: string;
  readonly callID: string;
  readonly title: string;
}

export interface RestartDetails {
  readonly at: number;
  readonly cause?: string | null | undefined;
  readonly tool?: InterruptedTool | null | undefined;
}

export interface InterruptedSession extends RestartDetails {
  readonly sessionId: string;
  readonly directory: string | null;
  readonly title: string | null;
  readonly recorded: boolean;
  readonly priority: boolean;
}

export interface MetadataUpdateResult {
  readonly changed: boolean;
  readonly metadata?: SessionMetadata | undefined;
}

export type UpdateMetadata = (
  sessionID: string,
  decide: MetadataDecider,
  options: { directory: string },
) => Promise<MetadataUpdateResult>;

export interface ResumePrompt {
  readonly sessionId: string;
  readonly directory: string;
  readonly text: string;
  readonly description: string;
  readonly metadata: {
    readonly source: string;
    readonly kind: string;
    readonly trigger: 'auto' | 'continue';
    readonly at: number;
    readonly cause: string;
    readonly tool: ResumeTool | null;
  };
}

export type ResumeTool = {
  readonly name: string;
  readonly input?: string;
};

export interface ResumeMemory {
  readonly events: { readonly high: number; readonly max: number } | null;
  readonly pressure: { readonly fullAvg60: number } | null;
}

export interface AutoResumeOptions {
  readonly updateMetadata: UpdateMetadata;
  readonly sendPrompt: (input: ResumePrompt) => Promise<Awaited<ReturnType<ReturnType<typeof OpenCode.make>['session']['synthetic']>> | void>;
  readonly readMemory: () => ResumeMemory | null | undefined;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type ResumeOutcome = 'sent' | 'manual' | 'skipped';
export interface ManualContinuation {
  readonly sessionId: string;
  readonly directory?: string;
  readonly at: number;
}
