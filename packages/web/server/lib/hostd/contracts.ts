declare const hostdIdentity: unique symbol;
export type HostdSpaceId = string & { readonly [hostdIdentity]: 'space' };
export type HostdToolsKey = string & { readonly [hostdIdentity]: 'tools' };
export type HostdPlace = 'host' | 'host-root';

export type HostdSpec<Id extends string = string> = {
  readonly id: Id;
  readonly name: string;
  readonly project: string;
  readonly created: string;
  readonly memoryBytes: number;
  readonly purpose?: 'general' | 'pr-fix-loop-approval';
};

/** Shape checked here; signature, origin and one-time activation remain root-ops' responsibility. */
export type HostdAssertion = {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
  readonly clientExtensionResults: Readonly<Record<string, unknown>>;
  readonly authenticatorAttachment?: 'platform' | 'cross-platform';
};

type ActivationPlace =
  | { readonly place: 'host'; readonly assertion?: never }
  | { readonly place: 'host-root'; readonly assertion?: HostdAssertion };
type SpaceTarget<Id extends string> = { readonly place: HostdPlace; readonly id: Id };

export type HostdExecRequest<Id extends string = string> = SpaceTarget<Id> & {
  readonly op: 'exec';
  readonly target: 'space' | 'gatekeeper';
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly keepTail?: boolean;
};
export type HostdAttachRequest<Id extends string = string> = SpaceTarget<Id> & {
  readonly op: 'attach';
  readonly argv?: readonly string[];
};

/** Caller intent, before hostd supplies defaults and checks ids, paths and field allowlists. */
export type HostdRequest<Id extends string = string, Key extends string = string> =
  | { readonly op: 'check' | 'root-status' | 'project-shares' }
  | { readonly op: 'list' | 'disk'; readonly place: HostdPlace }
  | (ActivationPlace & { readonly op: 'create'; readonly spec: HostdSpec<Id>; readonly startConfig?: string | null; readonly toolsKey: Key })
  | (ActivationPlace & { readonly op: 'start'; readonly id: Id })
  | (SpaceTarget<Id> & { readonly op: 'stop' | 'remove' | 'verify' })
  | HostdExecRequest<Id>
  | HostdAttachRequest<Id>
  | { readonly op: 'tools-ensure'; readonly key: Key; readonly input: string | null }
  | { readonly op: 'tools-prune'; readonly keep: readonly Key[] }
  | { readonly op: 'root-approval-challenge'; readonly code: string }
  | {
    readonly op: 'root-approval-complete'; readonly code: string;
    readonly credential: { readonly id: string; readonly publicKey: string; readonly rpID: string };
    readonly response: HostdAssertion; readonly label?: string;
  }
  | { readonly op: 'root-activation-options'; readonly action: 'create'; readonly spec: Omit<HostdSpec<Id>, 'created'> }
  | { readonly op: 'root-activation-options'; readonly action: 'start'; readonly id: Id }
  | { readonly op: 'share-project' | 'unshare-project' | 'project-owner'; readonly path: string };

type CheckedRequest = HostdRequest<HostdSpaceId, HostdToolsKey>;
export type ParsedHostdRequest = Exclude<CheckedRequest, { readonly op: 'create' | 'exec' }>
  | (Extract<CheckedRequest, { readonly op: 'create' }> & { readonly startConfig: string | null })
  | Required<HostdExecRequest<HostdSpaceId>>;

export type HostdRequestOptions = { readonly input?: Buffer; readonly timeoutMs?: number };
export type HostdExecOptions = { readonly stdin?: string | Buffer | undefined; readonly signal?: AbortSignal | undefined };
export type HostdExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
