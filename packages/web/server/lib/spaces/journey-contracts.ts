import type { z } from 'zod';
import type { transferSourceSchema } from './transfer-bundle.js';

export interface McpSubjectResult { readonly ok: boolean; readonly code?: string | undefined }
export interface McpSubjects {
  set(subject: string, connections: string[]): Promise<McpSubjectResult>;
  remove(subject: string): Promise<McpSubjectResult>;
}
export interface InternalCreation {
  readonly sourceDirectory?: string | undefined;
  readonly source?: z.infer<typeof transferSourceSchema> | undefined;
  readonly onAllocated?: ((entry: { id: string; directory: string }) => Promise<void>) | undefined;
  readonly waitUntilReady?: boolean;
}
export type RootActivationRequest = { readonly op: 'create'; readonly request: unknown } | { readonly op: 'start'; readonly spaceId: string };
export interface ApprovalCredential { readonly id: string; readonly publicKey: string; readonly rpID: string }
