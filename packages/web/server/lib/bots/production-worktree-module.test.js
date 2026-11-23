import { afterEach, expect, test } from 'bun:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { productionFixture } from './production.test-support.js';
import { loadCheckoutModules } from './production-worktree-module.test-support.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });

test('creates the owned checkout when loaded from disposable emitted modules', async () => {
  // Given
  const f = fixture = await productionFixture();
  const { worktrees: emitted } = await loadCheckoutModules(path.join(f.dataDir, 'emitted-worktrees'));
  const worktrees = emitted.createProductionBotWorktrees({ dataDir: f.dataDir, context: f.context, readItem: async () => f.item });

  // When
  const checkout = await worktrees.create(f.request);

  // Then
  expect(checkout).toEqual({ directory: path.join(f.dataDir, 'bot-worktrees', createHash('sha256').update(`${f.project.id}\0${f.item.id}`).digest('hex')),
    branch: 'bot/item-1', baseBranch: 'main', baseSha: f.base });
});
