export type SessionDispatchAdmissionInput = {
  readonly sessionId: string;
  readonly directory?: string | undefined;
  readonly operationId: string;
  readonly payload: unknown;
  readonly text?: string | undefined;
  readonly selection?: unknown;
};
export type SessionDispatchAdmission = (input: SessionDispatchAdmissionInput) => Promise<void>;
export type SessionNativeDispatch = (input: SessionDispatchAdmissionInput & {
  readonly operation: 'prompt' | 'command' | 'synthetic' | 'model' | 'agent';
  readonly admissionId: string;
}) => Promise<{ readonly data: unknown } | undefined>;
