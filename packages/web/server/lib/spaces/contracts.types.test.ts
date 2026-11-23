import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseSpaceLabels } from './labels.js';
import { createModelGrants } from './model-grants.js';
import { createRegistryToolsSource, readHostToolVersions } from './tools.js';
import { requireApprovalModel } from './approval-profile.js';
import { parseSnapshotMetadata, transferSourceSchema } from './transfer-bundle.js';
import { withBundleDirectory } from './transfer-bundle.js';
import type { HistoryResult } from './code-in.js';
import type { createAgentCodeIn } from './agent-code-transfer.js';

describe('space boundary types', () => {
  it('retains checked source variants and history completion results', () => {
    // Given a Bot descriptor accepted by the transfer boundary.
    const input = { kind: 'bot-checkout', projectDirectory: '/project', projectId: 'project', botId: 'bot', itemId: 'item', checkoutKey: 'item:worktree' };
    // When the existing source parser accepts it.
    const source = transferSourceSchema.parse(input);
    // Then its checked fields and the adapter completion contract stay concrete.
    expect(source).toEqual(input);
    expectTypeOf<ReturnType<typeof parseSnapshotMetadata>['source']>().toEqualTypeOf<typeof source | undefined>();
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof createAgentCodeIn>['sendHistory']>>>().toEqualTypeOf<HistoryResult>();
    expectTypeOf<ReturnType<typeof withBundleDirectory<string>>>().toEqualTypeOf<Promise<string>>();
  });

  it('returns the checked reviewed model without widening its purpose', () => {
    // Given a reviewed inference model selected for an approval worker.
    const input = { providerID: 'openai', modelID: 'gpt-4.1' };
    // When the approval preflight checks that selection.
    const model = requireApprovalModel('pr-fix-loop-approval', input);
    // Then callers receive the checked model or the ordinary-purpose null result.
    expect(model).toEqual(input);
    expectTypeOf(model).toEqualTypeOf<{ providerID: string; modelID: string } | null>();
  });

  it('does not turn coercible labels into checked strings', () => {
    const id = [123456789012];
    const labels = parseSpaceLabels<unknown>({
      'openchamber.space': 'true',
      'openchamber.space.id': id,
      'openchamber.space.role': 'space',
      'openchamber.space.owner': 'owner',
      'openchamber.space.name': 7,
    });
    expect(labels?.id).toBe(id);
    expect(labels?.name).toBe(7);
    expectTypeOf(labels?.id).toBeUnknown();
    expectTypeOf(labels?.name).toBeUnknown();
  });

  it('keeps version values that the coercing pattern accepts', () => {
    const version = ['1.2.3'];
    const source = createRegistryToolsSource({ webVersion: version, openCodeVersion: '2.3.0' });
    expect(source.canonical.packages['@openchamber/web']).toBe(version);
    expectTypeOf(source.canonical.packages['@openchamber/web']).toBeUnknown();
    expectTypeOf<ReturnType<typeof readHostToolVersions>['webVersion']>().toBeUnknown();
  });

  it('keeps the environment secret check for inherited dictionary entries', async () => {
    const environment: NodeJS.ProcessEnv = {};
    const grants = createModelGrants({
      hostCatalog: { read: async () => null, list: async () => [], readStoredKey: async () => null },
      readHostSecret: (name) => environment[name],
    });
    await expect(grants.modelGrantOf({
      kind: 'model',
      provider: 'openai',
      upstream: 'https://api.openai.com/v1',
      secret: { kind: 'env', name: 'constructor' },
    }, null)).rejects.toMatchObject({ code: 'secret_source_missing' });
  });
});
