import { isFileEditorPattern, matchesFileEditorPattern } from './file-editor.ts';

/**
 * Plan providers (`contributes.plans`): an extension shows plans another tool
 * keeps as files in the worktree (`root`), in OpenChamber's Plans area. The
 * files stay where they are and stay the only copy. The host lists them, reads
 * and writes them; the extension only describes them (title, progress, state,
 * which of its declared actions apply) and declares the actions. An action is
 * a fixed command, skill or prompt from the manifest, approved with the
 * `plans` capability; the host fills in the plan's path and runs it in a new
 * session after the user confirms the exact text.
 */

/** How many providers one package may declare. */
export const GUEST_PLAN_PROVIDERS_MAX = 4;
/** Characters in a provider or action label. */
export const GUEST_PLAN_LABEL_MAX = 40;
/** Characters in a provider `root`. */
export const GUEST_PLAN_ROOT_MAX = 256;
/** How many file-name patterns one provider may declare. */
export const GUEST_PLAN_MATCH_MAX = 8;
/** File-name patterns when a provider declares none. */
export const GUEST_PLAN_MATCH_DEFAULT: readonly string[] = ['*.md'];
/** How many actions one provider may declare. */
export const GUEST_PLAN_ACTIONS_MAX = 6;
/** Characters in an action's text or arguments template. */
export const GUEST_PLAN_TEMPLATE_MAX = 4_000;
/** Directories below `root` the host looks into; files deeper than this are not plans. */
export const GUEST_PLAN_DEPTH_MAX = 4;
/** Plans the host lists per provider and worktree; the rest is reported as truncated. */
export const GUEST_PLANS_MAX = 500;
/** Characters in a plan title from an annotation. */
export const GUEST_PLAN_TITLE_MAX = 200;
/** Characters in a plan status label from an annotation. */
export const GUEST_PLAN_STATUS_MAX = 40;
/** Largest step count an annotation may report. */
export const GUEST_PLAN_PROGRESS_MAX = 100_000;
/** Characters in a plan file the host reads or writes. */
export const GUEST_PLAN_CONTENT_MAX = 2_000_000;
/** Characters in an annotation error. */
export const GUEST_PLAN_ERROR_MAX = 500;

/** An OpenCode command or skill name an action may run. */
export const GUEST_PLAN_RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** An agent name an action may ask for. */
export const GUEST_PLAN_AGENT_MAX = 64;

export const GUEST_PLAN_ACTION_KINDS = ['review', 'execute', 'resume'] as const;
/** What an action does to the plan; the host groups and words its controls by this. */
export type GuestPlanActionKind = (typeof GUEST_PLAN_ACTION_KINDS)[number];

export const GUEST_PLAN_STATUS_TONES = ['neutral', 'info', 'success', 'warning', 'error'] as const;
export type GuestPlanStatusTone = (typeof GUEST_PLAN_STATUS_TONES)[number];

/** The only placeholders an action template may use. */
export const GUEST_PLAN_PLACEHOLDERS = ['plan.path', 'plan.name'] as const;
export type GuestPlanPlaceholder = (typeof GUEST_PLAN_PLACEHOLDERS)[number];

/**
 * What an action starts, in a new session in the plan's worktree:
 * - `command`: the OpenCode command `name` with `arguments` (a template).
 * - `skill`: a prompt `text` (a template) with the skill `name` attached.
 * - `prompt`: the `text` template, sent as written; a leading `/` is not a command.
 * A name the worktree does not know refuses the action; nothing else runs instead.
 */
export type GuestPlanActionRun =
  | { type: 'command'; name: string; arguments?: string }
  | { type: 'skill'; name: string; text: string }
  | { type: 'prompt'; text: string };

export type GuestPlanActionContribution = {
  id: string;
  kind: GuestPlanActionKind;
  label: string;
  run: GuestPlanActionRun;
  /** Agent the new session uses; the action is refused when the worktree has no such agent. Default: the user's default agent. */
  agent?: string;
};

export type GuestPlanProviderContribution = {
  id: string;
  label: string;
  /** Worktree-relative folder that holds the plans, like `.plans` or `docs/plans`. */
  root: string;
  /** File-name patterns (as in `fileEditors`) a plan matches; default `["*.md"]`. */
  match?: string[];
  actions?: GuestPlanActionContribution[];
};

const PLAN_SEGMENT = /^[A-Za-z0-9._-]+$/;

const validSegments = (value: string): boolean => {
  const segments = value.split('/');
  return segments.every((segment) => PLAN_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
};

/** A provider `root`: relative, `/`-separated, segments of letters, digits, `.`, `_`, `-`, never `.` or `..`. */
export const isGuestPlanRoot = (value: string): boolean => (
  value.length > 0 && value.length <= GUEST_PLAN_ROOT_MAX && validSegments(value)
);

/** A worktree-relative plan path with the same segment rules as `root`, at most 1024 characters. */
export const isGuestPlanPath = (value: string): boolean => (
  value.length > 0 && value.length <= 1_024 && validSegments(value)
);

export const isGuestPlanMatchPattern = isFileEditorPattern;

export const guestPlanMatch = (provider: Pick<GuestPlanProviderContribution, 'match'>): readonly string[] => (
  provider.match && provider.match.length > 0 ? provider.match : GUEST_PLAN_MATCH_DEFAULT
);

/**
 * Whether `path` is a plan of this provider: inside `root`, at most
 * `GUEST_PLAN_DEPTH_MAX` folders below it, file name matching `match`.
 */
export const isGuestPlanPathOf = (
  provider: Pick<GuestPlanProviderContribution, 'root' | 'match'>,
  path: string,
): boolean => {
  if (!isGuestPlanPath(path) || !path.startsWith(`${provider.root}/`)) return false;
  const rest = path.slice(provider.root.length + 1).split('/');
  if (rest.length > GUEST_PLAN_DEPTH_MAX + 1) return false;
  const name = rest[rest.length - 1] ?? '';
  return guestPlanMatch(provider).some((pattern) => matchesFileEditorPattern(name, pattern));
};

/** The file name without its last extension: `.plans/auth-flow.md` → `auth-flow`. */
export const guestPlanName = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(GUEST_PLAN_PLACEHOLDERS);
const STATUS_TONES: ReadonlySet<string> = new Set(GUEST_PLAN_STATUS_TONES);

/** Whether every `{…}` in `template` is one of `GUEST_PLAN_PLACEHOLDERS`. */
export const isGuestPlanTemplate = (template: string): boolean => {
  if (template.length > GUEST_PLAN_TEMPLATE_MAX) return false;
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!PLACEHOLDER_NAMES.has(match[1] ?? '')) return false;
  }
  return true;
};

/** Fill `{plan.path}` and `{plan.name}`; the path must already be a checked plan path. */
export const renderGuestPlanTemplate = (template: string, path: string): string => (
  template.replace(PLACEHOLDER, (whole, key: string) => {
    if (key === 'plan.path') return path;
    if (key === 'plan.name') return guestPlanName(path);
    return whole;
  })
);

/** What a provider's action resolves to for one plan: the exact thing the user confirms. */
export type GuestPlanActionInvocation =
  | { type: 'command'; name: string; arguments: string; agent?: string }
  | { type: 'skill'; name: string; text: string; agent?: string }
  | { type: 'prompt'; text: string; agent?: string };

export const resolveGuestPlanAction = (
  action: GuestPlanActionContribution,
  path: string,
): GuestPlanActionInvocation => {
  const agent = action.agent ? { agent: action.agent } : {};
  switch (action.run.type) {
    case 'command':
      return { type: 'command', name: action.run.name, arguments: renderGuestPlanTemplate(action.run.arguments ?? '', path), ...agent };
    case 'skill':
      return { type: 'skill', name: action.run.name, text: renderGuestPlanTemplate(action.run.text, path), ...agent };
    case 'prompt':
      return { type: 'prompt', text: renderGuestPlanTemplate(action.run.text, path), ...agent };
  }
};

/**
 * The approval scope of `contributes.plans`: what the user saw when they
 * allowed `plans`. Sorted so that reordering is not a change; any other change
 * to a root, a pattern or an action asks again.
 */
export const guestPlanProvidersScope = (providers: readonly GuestPlanProviderContribution[]): string => JSON.stringify(
  [...providers]
    .map((provider) => ({
      id: provider.id,
      root: provider.root,
      match: [...guestPlanMatch(provider)].sort(),
      actions: [...(provider.actions ?? [])]
        .map((action) => ({ id: action.id, kind: action.kind, agent: action.agent ?? null, run: action.run }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
);

// Wire

/** One plan file the host found, as it asks the extension to describe it. */
export type GuestPlanFile = { path: string };

/** Host → guest `plans-annotate`: describe these plans of `provider` in `directory`. */
export type PlansAnnotateRequest = {
  provider: string;
  /** The worktree the plans are in; the frame's own directory. */
  directory: string;
  plans: GuestPlanFile[];
};

export type GuestPlanProgress = { done: number; total: number };

export type GuestPlanStatus = { label: string; tone?: GuestPlanStatusTone };

/**
 * What the extension says about one plan. Every field is optional: a plan
 * without an annotation is listed by its file name with unknown progress.
 * `actions` names the declared action ids that apply to this plan now; when
 * omitted every declared action applies.
 */
export type GuestPlanAnnotation = {
  path: string;
  title?: string;
  progress?: GuestPlanProgress;
  status?: GuestPlanStatus;
  actions?: string[];
};

/** The guest's answer to `plans-annotate`. */
export type PlansAnnotateResultPayload = { annotations: GuestPlanAnnotation[] } | { error: string };

/** Guest → host `plan-read`: one plan of a declared provider in the frame's directory. Needs `plans`. */
export type PlanReadRequest = { provider: string; path: string };
/** `hash` is the SHA-256 of the UTF-8 bytes, hex. */
export type PlanReadResult = { content: string; hash: string };

/** Guest → host `plans-changed`: the provider's plans changed; the host lists them again. */
export type PlansChangedRequest = { provider: string };

const clampText = (value: string | undefined, max: number): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= GUEST_PLAN_PROGRESS_MAX;

/**
 * What `connectHost` sends for an annotation answer: titles and labels cut to
 * their limits, invalid progress and paths dropped, one entry per path, at
 * most `GUEST_PLANS_MAX`. The host schema refuses anything this would not send.
 */
export const clampGuestPlanAnnotations = (annotations: readonly GuestPlanAnnotation[]): GuestPlanAnnotation[] => {
  const seen = new Set<string>();
  const result: GuestPlanAnnotation[] = [];
  for (const annotation of annotations) {
    if (result.length >= GUEST_PLANS_MAX) break;
    if (!isGuestPlanPath(annotation.path) || seen.has(annotation.path)) continue;
    seen.add(annotation.path);
    const next: GuestPlanAnnotation = { path: annotation.path };
    const title = clampText(annotation.title, GUEST_PLAN_TITLE_MAX);
    if (title) next.title = title;
    const progress = annotation.progress;
    if (progress && isCount(progress.done) && isCount(progress.total) && progress.done <= progress.total) {
      next.progress = { done: progress.done, total: progress.total };
    }
    const label = clampText(annotation.status?.label, GUEST_PLAN_STATUS_MAX);
    if (label) {
      const tone = annotation.status?.tone;
      next.status = tone && STATUS_TONES.has(tone) ? { label, tone } : { label };
    }
    if (annotation.actions) {
      next.actions = [...new Set(annotation.actions.filter((id) => /^[a-z][a-z0-9-]*$/.test(id)))]
        .slice(0, GUEST_PLAN_ACTIONS_MAX);
    }
    result.push(next);
  }
  return result;
};
