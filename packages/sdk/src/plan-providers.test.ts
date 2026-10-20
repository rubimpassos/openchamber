import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION } from './api-version.ts';
import { requestedGuestCapabilities } from './manifest.ts';
import type { JsonValue } from './contract.ts';
import { parseManifestJson } from './parse.ts';
import {
  clampGuestPlanAnnotations,
  guestPlanName,
  guestPlanProvidersScope,
  isGuestPlanPathOf,
  isGuestPlanRoot,
  renderGuestPlanTemplate,
  resolveGuestPlanAction,
  type GuestPlanProviderContribution,
} from './plan-providers.ts';
import { guestMessageSchema, hostMessageSchema } from './protocol.ts';

const provider: GuestPlanProviderContribution = {
  id: 'shelf',
  label: 'Shelf plans',
  root: '.shelf/plans',
  actions: [
    { id: 'execute', kind: 'execute', label: 'Run', run: { type: 'command', name: 'shelf-run', arguments: '{plan.name}' } },
    { id: 'review', kind: 'review', label: 'Review', run: { type: 'prompt', text: 'Review {plan.path}.' }, agent: 'planner' },
  ],
};

const manifest = (plans: JsonValue, panel: { entry?: string } = { entry: 'index.html' }) => parseManifestJson(JSON.stringify({
  apiVersion: OPENCHAMBER_SDK_API_VERSION,
  contributes: { panel: { id: 'shelf', name: 'Shelf', icon: 'file-list', ...panel }, plans },
}));

describe('contributes.plans', () => {
  test('reads a provider and asks for the plans capability', () => {
    const result = manifest([provider]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.plans).toEqual([provider]);
    expect(requestedGuestCapabilities(result.manifest.contributes)).toEqual(['plans']);
  });

  test('a background entry is enough, but a provider needs a frame to describe its plans', () => {
    expect(parseManifestJson(JSON.stringify({
      apiVersion: OPENCHAMBER_SDK_API_VERSION,
      contributes: { panel: { id: 'shelf', name: 'Shelf', icon: 'file-list' }, background: { entry: 'bg.html' }, plans: [provider] },
    })).ok).toBe(true);
    expect(manifest([provider], {})).toMatchObject({ ok: false, code: 'invalid-panel' });
  });

  test('refuses roots, patterns, templates and actions outside the contract', () => {
    const invalid: JsonValue[] = [
      [],
      [{ ...provider, root: '../plans' }],
      [{ ...provider, root: '/abs/plans' }],
      [{ ...provider, root: 'plans/./x' }],
      [{ ...provider, root: 'plans\\x' }],
      [{ ...provider, match: ['a/b.md'] }],
      [{ ...provider, actions: [{ ...provider.actions![0], run: { type: 'command', name: 'run', arguments: '{plan.title}' } }] }],
      [{ ...provider, actions: [{ ...provider.actions![0], run: { type: 'shell', text: 'rm -rf /' } }] }],
      [{ ...provider, actions: [{ ...provider.actions![0], run: { type: 'command', name: 'bad name' } }] }],
      [{ ...provider, actions: [{ ...provider.actions![0], run: { type: 'prompt', text: '   ' } }] }],
      [{ ...provider, actions: [provider.actions![0], provider.actions![0]] }],
      [provider, provider],
      [{ ...provider, extra: true }],
    ];
    for (const plans of invalid) {
      expect(manifest(plans)).toMatchObject({ ok: false, code: 'invalid-plans' });
    }
  });
});

describe('plan paths', () => {
  test('only files under root, within the depth, matching the patterns, are plans of a provider', () => {
    expect(isGuestPlanRoot('.shelf/plans')).toBe(true);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/auth.md')).toBe(true);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/a/b/c/d/auth.md')).toBe(true);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/a/b/c/d/e/auth.md')).toBe(false);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/auth.txt')).toBe(false);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/../secret.md')).toBe(false);
    expect(isGuestPlanPathOf(provider, '.shelf/plansx/auth.md')).toBe(false);
    expect(isGuestPlanPathOf(provider, '.shelf/plans/my plan.md')).toBe(false);
    expect(isGuestPlanPathOf({ ...provider, match: ['*.plan.md'] }, '.shelf/plans/auth.md')).toBe(false);
  });

  test('templates fill only the plan path and name', () => {
    expect(guestPlanName('.shelf/plans/auth-flow.md')).toBe('auth-flow');
    expect(renderGuestPlanTemplate('/x {plan.name} at {plan.path} {other}', '.shelf/plans/auth.md'))
      .toBe('/x auth at .shelf/plans/auth.md {other}');
    expect(resolveGuestPlanAction(provider.actions![0]!, '.shelf/plans/auth.md'))
      .toEqual({ type: 'command', name: 'shelf-run', arguments: 'auth' });
    expect(resolveGuestPlanAction(provider.actions![1]!, '.shelf/plans/auth.md'))
      .toEqual({ type: 'prompt', text: 'Review .shelf/plans/auth.md.', agent: 'planner' });
  });

  test('the approval scope ignores order and labels, and changes with any action', () => {
    const reordered = { ...provider, label: 'Other label', actions: [...provider.actions!].reverse() };
    expect(guestPlanProvidersScope([reordered])).toBe(guestPlanProvidersScope([provider]));
    const moved = { ...provider, actions: [{ ...provider.actions![0]!, run: { type: 'command' as const, name: 'other' } }] };
    expect(guestPlanProvidersScope([moved])).not.toBe(guestPlanProvidersScope([provider]));
  });
});

describe('plan wire', () => {
  test('annotations are clamped before they cross, and the host schema accepts what was clamped', () => {
    const clamped = clampGuestPlanAnnotations([
      { path: '.shelf/plans/a.md', title: `  ${'t'.repeat(400)} `, progress: { done: 2, total: 5 }, status: { label: 'Running', tone: 'info' }, actions: ['execute', 'BAD', 'execute'] },
      { path: '.shelf/plans/a.md', title: 'duplicate' },
      { path: '../x.md' },
      { path: '.shelf/plans/b.md', progress: { done: 6, total: 5 } },
    ]);
    expect(clamped).toHaveLength(2);
    expect(clamped[0]?.title).toHaveLength(200);
    expect(clamped[0]?.actions).toEqual(['execute']);
    expect(clamped[1]).toEqual({ path: '.shelf/plans/b.md' });
    const message = { channel: 'openchamber.sdk', v: 1, type: 'plans-annotate-result', id: 'p1', payload: { annotations: clamped } };
    expect(guestMessageSchema.safeParse(message).success).toBe(true);
    expect(guestMessageSchema.safeParse({ ...message, payload: { annotations: [{ path: '/etc/passwd' }] } }).success).toBe(false);
  });

  test('plan reads and change notices name a provider and a plan path, and the host request carries paths only', () => {
    expect(guestMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'plan-read', id: 'r', payload: { provider: 'shelf', path: '.shelf/plans/a.md' } }).success).toBe(true);
    expect(guestMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'plan-read', id: 'r', payload: { provider: 'shelf', path: '../a.md' } }).success).toBe(false);
    expect(guestMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'plans-changed', id: 'c', payload: { provider: 'shelf' } }).success).toBe(true);
    expect(hostMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'plans-annotate', id: 'a', payload: { provider: 'shelf', directory: '/repo', plans: [{ path: '.shelf/plans/a.md' }] } }).success).toBe(true);
    const read = hostMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'result', id: 'r', ok: true, payload: { content: '# A', hash: 'a'.repeat(64) } });
    expect(read.success && read.data.type === 'result' && read.data.ok ? read.data.payload : null).toEqual({ content: '# A', hash: 'a'.repeat(64) });
  });
});
