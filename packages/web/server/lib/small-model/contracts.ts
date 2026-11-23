import type {
  ExperimentalGenerateTextInput,
  ExperimentalSessionImportInput,
  OpenCode,
  OpenCodeClient,
} from '@opencode/client/promise';

export interface TextGenerationCache {
  get(key: TextGenerationCacheKey): Promise<{ readonly buffer: Buffer } | null>;
  set(key: TextGenerationCacheKey, buffer: Buffer): Promise<void>;
}

export interface TextGenerationCacheKey {
  readonly providerID: unknown;
  readonly modelID: unknown;
  readonly variant?: string;
  readonly prompt: string;
}

type GenerateAPI = OpenCodeClient['experimental']['generate'];
type SessionAPI = OpenCodeClient['experimental']['session'];

type ForwardedSessionImportInput = Omit<ExperimentalSessionImportInput, 'info' | 'messages'> & {
  readonly info: object;
  readonly messages: unknown;
};

export type ForwardedGenerationInput = Omit<ExperimentalGenerateTextInput, 'model'> & {
  model?: {
    id: unknown;
    providerID: unknown;
    variant?: string;
  } | null | undefined;
};

export type SmallModelClient = Omit<OpenCodeClient, 'experimental'> & {
  experimental: Omit<OpenCodeClient['experimental'], 'generate' | 'session'> & {
    session: Omit<SessionAPI, 'import'> & {
      import: (input: ForwardedSessionImportInput, options?: OpenCode.RequestOptions) => ReturnType<SessionAPI['import']>;
    };
    generate: Omit<GenerateAPI, 'text'> & {
      text: (
        input: ForwardedGenerationInput,
        options?: OpenCode.RequestOptions,
      ) => ReturnType<GenerateAPI['text']>;
    };
  };
};
