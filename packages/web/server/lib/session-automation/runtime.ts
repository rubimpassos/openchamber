export interface PullRequestIdentity {
  readonly provider: string;
  readonly instance?: string | null;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}
export interface AutomationClaim {
  readonly owner: string;
  readonly keys: readonly string[];
}
export interface AutomationAdmissionOptions {
  readonly restore?: () => Promise<readonly AutomationClaim[]>;
  readonly onRelease?: (keys: readonly string[]) => void;
}

export const sessionKey = (sessionID: string) => `session:${sessionID}`;
export const pullRequestKey = ({ provider, instance, owner, repo, number }: PullRequestIdentity) => (
  `pull:${provider.toLowerCase()}|${(instance || 'github.com').toLowerCase()}|${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`
);
export const reviewOwner = (sessionID: string) => `review:${sessionID}`;
export const fixLoopOwner = (id: string) => `fixloop:${id}`;

const conflict = () => Object.assign(new Error('This session or pull request is owned by another automation or an in-flight send.'), { status: 409, statusCode: 409 });

export function createAutomationAdmission({ restore = async () => [], onRelease = () => {} }: AutomationAdmissionOptions = {}) {
  const owners = new Map<string, Set<string>>();
  const sends = new Map<string, symbol>();
  let loading: Promise<void> | undefined;
  let restored = false;

  const ready = () => {
    loading ??= (async () => {
      for (const { owner, keys } of await restore()) owners.set(owner, new Set(keys));
      restored = true;
    })();
    return loading;
  };
  const conflicts = (owner: string | null, keys: readonly string[]) => [...owners].some(([other, held]) => other !== owner && keys.some((key) => held.has(key)));
  const owns = (owner: string) => {
    const held = owners.get(owner);
    return restored && held !== undefined && !conflicts(owner, [...held]);
  };
  const claim = (owner: string, keys: readonly string[]) => {
    if (!restored || conflicts(owner, keys) || keys.some((key) => sends.has(key))) throw conflict();
    owners.set(owner, new Set(keys));
  };
  const release = (owner: string) => {
    const keys = owners.get(owner);
    owners.delete(owner);
    if (keys) onRelease([...keys]);
  };
  const trySend = (owner: string | null, keys: readonly string[]) => {
    if (!restored || (owner !== null && !owns(owner)) || conflicts(owner, keys) || keys.some((key) => sends.has(key))) return null;
    const token = Symbol();
    for (const key of keys) sends.set(key, token);
    return () => {
      for (const key of keys) if (sends.get(key) === token) sends.delete(key);
      onRelease(keys);
    };
  };
  return { ready, claim, release, owns, trySend };
}
