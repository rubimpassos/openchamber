import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { botInputDigest, createBotEffects } from '../effects.js';
import { createBotExecutionStore } from '../execution-store.js';
import { createBotItem } from '../schema.js';
import { createBotStore } from '../store.js';
import type { JsonValue } from '../../shared/json-values.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp('/tmp/opencode/bot-effect-recovery-');
  roots.push(root);
  const store = createBotStore({ projectsDirPath: root });
  const item = createBotItem({ id: 'item', botId: 'bot', title: 'Recovery', source: { kind: 'manual', id: 'source' } });
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
  const journal = createBotExecutionStore({ store });
  const effects = createBotEffects({ store, journal });
  const identity = { projectId: 'project', itemId: item.id, key: 'stage', kind: 'session.create' as const,
    authority: { service: 'opencode' as const, identityId: 'local', revision: 1, target: item.id } };
  return { effects, store, journal, identity };
}

it('settles an uncertain effect by reconciliation without an execution callback', async () => {
  const { effects, store, identity } = await fixture();
  await expect(effects.run({ ...identity, request: { stage: 'fixing' },
    execute: async () => { throw new Error('Lost acknowledgement'); },
    reconcile: async () => ({ state: 'outcome-unknown' }),
  })).rejects.toThrow();

  const receipt = await effects.recover({ ...identity,
    reconcile: async () => ({ state: 'succeeded', result: { id: 'recovered-session' } }),
  });

  expect(receipt).toEqual({ id: 'recovered-session' });
  expect((await store.read('project')).items[0]?.effects[0]?.state).toBe('succeeded');
});

it('leaves a prepared effect unclaimed when recovery cannot execute it', async () => {
  const { effects, store, identity } = await fixture();
  await expect(effects.run({ ...identity, request: { stage: 'fixing' },
    beforeDispatch: async () => { throw new Error('Not admitted'); },
    execute: async () => ({ id: 'new-session' }),
    reconcile: async () => ({ state: 'outcome-unknown' }),
  })).rejects.toThrow();
  let reconciled = false;

  await expect(effects.recover({ ...identity,
    reconcile: async () => { reconciled = true; return { state: 'succeeded', result: { id: 'unsent-session' } }; },
  })).rejects.toThrow();

  expect(reconciled).toBe(false);
  expect((await store.read('project')).items[0]?.effects[0]?.state).toBe('prepared');
});

it('rejects a changed capture before reconciling an uncertain effect', async () => {
  const { effects, store, journal, identity } = await fixture();
  await expect(effects.run({ ...identity, request: { stage: 'fixing' },
    execute: async () => { throw new Error('Lost acknowledgement'); },
    reconcile: async () => ({ state: 'outcome-unknown' }),
  })).rejects.toThrow();
  const entry = await journal.read('project', 'item');
  const file = path.join(path.dirname(store.filePathFor('project')), 'bot-executions', `${createHash('sha256').update('item').digest('hex')}.json`);
  await fs.writeFile(file, JSON.stringify({ ...entry,
    operations: { ...entry.operations, [identity.key]: { stage: 'judge' } },
  }));
  let reconciled = false;

  await expect(effects.recover({ ...identity,
    reconcile: async () => { reconciled = true; return { state: 'succeeded', result: { id: 'changed-session' } }; },
  })).rejects.toMatchObject({ code: 'BOT_EFFECT_AUTHORITY_CHANGED' });

  expect(reconciled).toBe(false);
});

it('replays a successful effect receipt without reconciling', async () => {
  const { effects, identity } = await fixture();
  await effects.run({ ...identity, request: { stage: 'fixing' },
    execute: async () => ({ id: 'existing-session' }),
    reconcile: async () => ({ state: 'outcome-unknown' }),
  });
  let reconciled = false;

  const receipt = await effects.recover({ ...identity,
    reconcile: async () => { reconciled = true; return { state: 'outcome-unknown' }; },
  });

  expect(receipt).toEqual({ id: 'existing-session' });
  expect(reconciled).toBe(false);
});

it('retains a refused effect without reconciling', async () => {
  const { effects, identity } = await fixture();
  await expect(effects.run({ ...identity, request: { stage: 'fixing' },
    execute: async () => { throw Object.assign(new Error('Refused'), { state: 'refused', code: 'BOT_TEST_REFUSED' }); },
    reconcile: async () => ({ state: 'outcome-unknown' }),
  })).rejects.toMatchObject({ code: 'BOT_TEST_REFUSED' });
  let reconciled = false;

  await expect(effects.recover({ ...identity,
    reconcile: async () => { reconciled = true; return { state: 'outcome-unknown' }; },
  })).rejects.toMatchObject({ code: 'BOT_TEST_REFUSED', state: 'refused' });

  expect(reconciled).toBe(false);
});

it('reconciles a dispatching effect with its original captured request', async () => {
  const { effects, store, journal, identity } = await fixture();
  const request = { stage: 'fixing', prompt: 'captured-input' };
  await journal.update('project', 'item', (entry) => ({ ...entry,
    operations: { ...entry.operations, [identity.key]: request },
  }));
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
    effects: [{ key: identity.key, kind: identity.kind, authority: identity.authority,
      inputDigest: botInputDigest(request), createdAt: 1, updatedAt: 1, state: 'prepared' as const }],
  })) } }));
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
    effects: item.effects.map((effect) => ({ ...effect, state: 'dispatching' as const,
      owner: { pid: process.pid, host: 'test-host' }, updatedAt: 2 })),
  })) } }));
  let captured: JsonValue | undefined;

  const receipt = await effects.recover({ ...identity,
    reconcile: async (input) => { captured = input; return { state: 'succeeded', result: { id: 'observed-session' } }; },
  });

  expect(captured).toEqual({ stage: 'fixing', prompt: 'captured-input' });
  expect(receipt).toEqual({ id: 'observed-session' });
});
