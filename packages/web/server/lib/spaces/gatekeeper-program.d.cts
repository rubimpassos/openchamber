type ApprovalProtocol = 'openai' | 'codex' | 'anthropic' | 'copilot';
type ApprovalModel = { readonly providerID: string; readonly modelID: string };

/** Host-facing exports of the standalone, standard-library-only gatekeeper. */
declare const rules: {
  readonly approvalPolicy: {
    readonly purpose: 'pr-fix-loop-approval';
    readonly reviewedModel: (model: ApprovalModel | null | undefined) => readonly string[] | null | undefined;
    readonly supportsProtocol: (protocol: ApprovalProtocol, model: ApprovalModel | null | undefined) => boolean;
    readonly protocolOf: (grant: unknown) => ApprovalProtocol | null;
    readonly networkAllowed: (network: unknown) => boolean;
    readonly grantAllowed: (grant: unknown) => boolean;
    readonly requestAllowed: (protocol: ApprovalProtocol, request: unknown) => boolean;
    readonly bodyAllowed: (body: unknown, context: unknown) => boolean;
  };
};
export = rules;
