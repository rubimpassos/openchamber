import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAdoptionProbe, runIgnoredRaceProbe, runAncestryProbe } from './production-isolated.driver.mjs';
import { loadCheckoutModules } from './production-worktree-module.test-support.ts';

const root = await fs.mkdtemp('/tmp/opencode/bot-adoption-mutation-');
const replace = (source, before, after) => {
  assert(source.includes(before), `Mutation target changed: ${before}`);
  return source.replace(before, after);
};
try {
  await runAdoptionProbe();
  await runIgnoredRaceProbe();
  await runAncestryProbe();
  const mutants = [
    { name: 'configured host filters enabled', probe: runAdoptionProbe,
      changes: { 'production-git': (source) => replace(source, "    options.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);", '    void key;') },
      violation: /host filter/ },
    { name: 'durable adoption intent omitted', probe: runAdoptionProbe,
      changes: { 'production-worktree-adoption': (source) => replace(source, '        await save(request, record);', '') }, violation: /intent must be durable/ },
    { name: 'ignored-file refusal removed', probe: runIgnoredRaceProbe,
      changes: { 'production-git': (source) => replace(source, "'--no-overwrite-ignore', ", '') }, violation: /Late ignored user data/ },
    { name: 'current-head ancestry omitted', probe: runAncestryProbe,
      changes: { 'production-worktree-adoption': (source) => source.replaceAll('await requireAncestor(record.directory, fromSha, resultSha);', '') }, violation: /divergent result/ },
  ];
  const results = [];
  for (const [index, mutant] of mutants.entries()) {
    const { git, worktrees } = await loadCheckoutModules(path.join(root, `mutation-${index}`), mutant.changes);
    let failure;
    try { await mutant.probe({ createWorktrees: worktrees.createProductionBotWorktrees, advanceCheckout: git.advanceBotCheckout }); }
    catch (error) { failure = error; }
    assert(failure, `${mutant.name} did not turn its probe red`);
    assert.match(failure.message, mutant.violation, `${mutant.name} failed for a different reason`);
    results.push({ mutation: mutant.name, result: 'red for promised violation' });
  }
  await runAdoptionProbe();
  await runIgnoredRaceProbe();
  await runAncestryProbe();
  console.log(JSON.stringify({ original: 'green', mutants: results, restored: 'green',
    boundary: 'Disposable local module copies; no Docker or live provider claim' }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
