import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createBotDriver } from './runtime.test-support.js';

const directories = [];
const fixture = async (options) => {
  const root = await fs.mkdtemp('/tmp/opencode/bot-agents-'); directories.push(root);
  return createBotDriver(root, options);
};
const stateOf = async (driver, item) => (await driver.runtime.detail('project', item.id)).item;
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('project access', () => {
  it('ends a read-only bot after its investigation without a correction or any write', async () => {
    // Given a bot that may only read the project.
    const driver = await fixture({ bot: { projects: { project: 'read' } } });
    const item = await driver.admit();

    // When the coordinator runs it.
    await driver.runtime.pump('project');

    // Then it investigated, removed its checkout and finished.
    const current = await stateOf(driver, item);
    expect(current.state).toBe('done');
    expect(current.transitions.map((entry) => entry.to)).toEqual(['queued', 'investigating', 'done']);
    expect(driver.calls.effects).toEqual([]);
    expect(driver.calls.removed).toEqual([item.id]);
  });

  it('leaves the merge to a person when the bot may only open pull requests', async () => {
    // Given a bot that fixes and opens PRs, and a judge that would allow auto-merge.
    const driver = await fixture({ bot: { projects: { project: 'pr' } }, decision: 'auto' });
    const item = await driver.admit();

    // When it runs and the PR gets approved.
    await driver.runtime.pump('project');
    driver.controls.approved = true;
    await driver.runtime.pump('project');

    // Then the PR waits for a person and auto-merge was never requested.
    expect((await stateOf(driver, item)).state).toBe('in-review');
    expect(driver.calls.effects.map((entry) => entry.operation)).toEqual(['git.push', 'pr.open']);
  });

  it('refuses new work from a bot without access to the project', async () => {
    // Given a bot with access to another project only. When work is admitted, then it is refused.
    const driver = await fixture({ bot: { projects: { other: 'merge' } } });
    await expect(driver.admit()).rejects.toMatchObject({ code: 'BOT_PROJECT_ACCESS_REQUIRED' });
  });
});

describe('connectors', () => {
  it('delivers the work without publishing when the bot has no GitHub connector', async () => {
    // Given a bot without any service identity.
    const driver = await fixture({ bot: { identity: {} } });
    const item = await driver.admit();

    // When it runs through judgment.
    await driver.runtime.pump('project');

    // Then it fixed, proved and judged, then finished without a push or a PR.
    const current = await stateOf(driver, item);
    expect(current.state).toBe('done');
    expect(current.transitions.map((entry) => entry.to)).toEqual(['queued', 'investigating', 'fixing', 'proving', 'judging', 'done']);
    expect(current.proof.status).toBe('passed');
    expect(driver.calls.effects).toEqual([]);
    expect(driver.calls.publications).toEqual([]);
  });

  it('tells the correction session about a missing connector without stopping the item', async () => {
    // Given a correction session of a bot without Jira.
    const driver = await fixture({ bot: { identity: { github: { kind: 'app', identityId: 'github-app' } } }, held: ['fixing'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const sessionId = (await stateOf(driver, item)).sessions.fixing;

    // When it tries to comment on Jira.
    const call = driver.runtime.handleTool({ sessionId, action: 'jira.comment', input: { operationId: 'note', body: 'Done' } });

    // Then the call is refused for that step only.
    await expect(call).rejects.toMatchObject({ code: 'BOT_CONNECTOR_MISSING', status: 400 });
    expect((await stateOf(driver, item)).state).toBe('fixing');
  });
});

describe('artifacts', () => {
  it('asks the worker once for a missing artifact, then waits for the person before judgment', async () => {
    // Given a bot that must present a benchmark, and no presented page.
    const driver = await fixture({ bot: { artifacts: [{ id: 'benchmark', label: 'Benchmark before and after' }] } });
    const item = await driver.admit();

    // When it reaches judgment.
    await driver.runtime.pump('project');

    // Then a second correction round was asked for the benchmark, and only then it stopped before the judge.
    const current = await stateOf(driver, item);
    expect(current).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_ARTIFACTS_MISSING' } });
    expect(current.sessions.judge).toBeUndefined();
    const fixes = driver.calls.prompts.filter((prompt) => prompt.text.includes('Implement the correction'));
    expect(fixes).toHaveLength(2);
    expect(fixes[1].text).toContain('benchmark (Benchmark before and after)');
  });

  it('ignores a page presented before the current correction round', async () => {
    // Given a benchmark page drawn before the correction started.
    const driver = await fixture({ bot: { artifacts: [{ id: 'benchmark', label: 'Benchmark' }] }, now: 2_000_000_000_000 });
    driver.controls.presentedArtifacts = [{ requirement: 'benchmark', title: 'old', content: 'old', createdAt: 1 }];
    const item = await driver.admit();

    // When it reaches judgment, then the old page does not satisfy the requirement.
    await driver.runtime.pump('project');
    expect((await stateOf(driver, item)).wait?.reason).toBe('BOT_ARTIFACTS_MISSING');
  });

  it('sends work to review when the judge finds a presented artifact does not prove its requirement', async () => {
    // Given a presented benchmark and a judge that finds it unconvincing.
    const driver = await fixture({ bot: { artifacts: [{ id: 'benchmark', label: 'Benchmark before and after' }] }, decision: 'auto' });
    driver.controls.presentedArtifacts = [{ requirement: 'benchmark', title: 'p95', content: '<p>no numbers</p>' }];
    driver.controls.judgeArtifacts = [{ id: 'benchmark', proven: false, reason: 'No measurement' }];
    const item = await driver.admit();

    // When it is judged.
    await driver.runtime.pump('project');

    // Then the auto verdict became a review with the reason, and the judge saw the page.
    const current = await stateOf(driver, item);
    expect(current.state).toBe('in-review');
    expect(current.judgment).toMatchObject({ decision: 'review', reason: expect.stringContaining('benchmark (No measurement)') });
    expect(driver.calls.prompts.find((prompt) => prompt.text.includes('presentedArtifacts')).text).toContain('no numbers');
  });
});

describe('bot leads', () => {
  it('relays the user answer from the item conversation to the waiting question', async () => {
    // Given an item waiting on a question from its investigation.
    const driver = await fixture({ questions: ['Which behavior is expected?'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const waiting = await driver.runtime.detail('project', item.id);
    expect(waiting.item.state).toBe('waiting-answer');

    // When the conversation passes the user's answer with the question key, and repeats a stale one.
    const conversation = waiting.item.conversation.sessionId;
    await driver.runtime.handleTool({ sessionId: conversation, action: 'item.answer',
      input: { operationId: 'answer-1', questionKey: waiting.questionKey, text: 'Return 404' } });
    const stale = driver.runtime.handleTool({ sessionId: conversation, action: 'item.answer',
      input: { operationId: 'answer-2', questionKey: waiting.questionKey, text: 'Again' } });

    // Then the item continues and the stale key is refused.
    expect((await stateOf(driver, item)).state).not.toBe('waiting-answer');
    await expect(stale).rejects.toMatchObject({ code: expect.stringMatching(/BOT_QUESTION_CHANGED|BOT_ITEM_NOT_WAITING/) });
  });

  it('keeps every other bot action away from the item conversation', async () => {
    // Given an item conversation. When it asks to publish, then the coordinator refuses.
    const driver = await fixture({ held: ['investigation'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const conversation = (await stateOf(driver, item)).conversation.sessionId;
    await expect(driver.runtime.handleTool({ sessionId: conversation, action: 'git.push', input: { operationId: 'push' } }))
      .rejects.toMatchObject({ code: 'BOT_ACTION_UNSUPPORTED' });
  });

  it('lets the main chat list the bot work and start new work in a project it may access', async () => {
    // Given a bot with one waiting item.
    const driver = await fixture({ held: ['investigation'] });
    await driver.admit();
    await driver.runtime.pump('project');

    // When the main chat starts work twice under one operation and lists the work.
    const start = { operationId: 'chat-1', projectId: 'project', title: 'Check the export' };
    const first = await driver.runtime.handleMainTool({ botId: 'bugs', action: 'bot.start', input: start });
    const again = await driver.runtime.handleMainTool({ botId: 'bugs', action: 'bot.start', input: start });
    const work = await driver.runtime.handleMainTool({ botId: 'bugs', action: 'bot.items', input: {} });

    // Then one new item exists, and the list shows both with the project access.
    expect(again.item.id).toBe(first.item.id);
    expect(work.projects).toEqual([{ projectId: 'project', access: 'merge' }]);
    expect(work.items.map((entry) => entry.title).sort()).toEqual(['Check the export', 'Fix a verified defect']);
  });
});

describe('take over', () => {
  it('stops the coordinator, keeps the checkout and hands the worker session to the person', async () => {
    // Given an item whose correction is running.
    const driver = await fixture({ held: ['fixing'] });
    const item = await driver.admit();
    await driver.runtime.pump('project');
    const running = await stateOf(driver, item);
    const released = [];

    // When the person takes it over, and asks again after it ended.
    const result = await driver.runtime.takeOverItem('project', item.id, async (session) => { released.push(session); });
    await driver.runtime.takeOverItem('project', item.id, async (session) => { released.push(session); });

    // Then the item stopped without removing its checkout, and the same session was released both times.
    expect(result.item.state).toBe('stopped');
    expect(driver.calls.removed).toEqual([]);
    expect(released).toEqual([{ sessionId: running.sessions.fixing, directory: running.worktree }, { sessionId: running.sessions.fixing, directory: running.worktree }]);
    await expect(fs.stat(running.worktree)).resolves.toBeDefined();
  });
});
