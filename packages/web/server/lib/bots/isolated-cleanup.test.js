import fs from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { isolatedCleanupFixture, cleanupSpaceId, cleanupScope, cleanupBinding } from './isolated-cleanup.test-support.js';

const fixtures = [];
const setup = async (options) => { const fixture = await isolatedCleanupFixture(options); fixtures.push(fixture); return fixture; };
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

it.each(['stop', 'remove'])('recovers %s of an exited producer with real nonempty retention and no restored access', async (operation) => {
  const f = await setup();
  const remembered = f.records.read(cleanupSpaceId).record;
  f.state.onStart = async () => {
    expect((await f.build().readBinding(cleanupScope)).state).not.toBe('ready');
    expect(f.state.policy).toEqual({ mode: 'allowlist', domains: [], grants: [] });
    await expect(f.build().sessionOwner({ sessionId: cleanupBinding.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
    await expect(f.build().forwardTools({ spaceId: cleanupSpaceId, sessionId: cleanupBinding.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
    expect(await f.host.journey.sayLogin(cleanupSpaceId, remembered.grants[0], { methodID: 'chatgpt-token-sharing', access: 'disposable', metadata: {} })).toBeNull();
  };
  await f[operation]();
  expect((await f.artifacts.read(cleanupScope, f.reference.id)).payload.body.content).toBe('<p>retained-evidence</p>');
  expect(f.state.running).toBe(false);
  expect(f.state.gatekeeperRunning).toBe(false);
  expect(f.state.starts).toBe(1);
  expect((await f.adapter.readBinding(cleanupScope)).state).toBe(operation === 'stop' ? 'stopped' : 'removed');
  if (operation === 'stop') expect(f.records.read(cleanupSpaceId).record).toEqual(remembered);
  else {
    expect(f.state.events).toEqual(['stop', 'start', 'interrupt', 'collect', 'archive', 'interrupt', 'collect', 'remove', 'refs']);
    expect(f.imported.get(cleanupBinding.sessionId).messages[0].parts[0].text).toBe('Retained answer');
    expect(f.archive.sessionDirectory(cleanupSpaceId, cleanupBinding.sessionId)).toBeTruthy();
    await fs.rm(f.sourceDir, { recursive: true });
    expect((await f.artifacts.read(cleanupScope, f.reference.id)).artifact.id).toBe(f.reference.id);
  }
});

it.each(['start', 'policy-read', 'verify', 'activity', 'transfer', 'archive', 'remove'])('retains the source and stops temporary execution when %s fails', async (failure) => {
  const f = await setup();
  f.state.fail = failure;
  await expect(f.remove()).rejects.toThrow();
  expect(f.state.removed).toBe(false);
  expect(f.state.running).toBe(false);
  expect(f.state.gatekeeperRunning).toBe(false);
  expect((await f.source.list(cleanupBinding)).entries.map((entry) => entry.metadata.id)).toEqual([f.reference.id]);
  expect(f.records.read(cleanupSpaceId).status).toBe('ok');
  expect((await f.build().readBinding(cleanupScope)).state).not.toBe('ready');
  f.state.fail = null;
  await f.remove();
  expect(f.state.removed).toBe(true);
});

it('collects again after archival in the same temporary run even with an earlier durable receipt', async () => {
  const f = await setup({ binding: { state: 'stopped', artifactsCollected: true } });
  f.state.onArchive = async () => { await f.capture('captured-during-archive'); };
  await f.remove();
  expect(f.state.starts).toBe(1);
  expect(f.state.collects).toBe(2);
  expect((await f.artifacts.list(cleanupScope)).artifacts.map((entry) => entry.title).sort()).toEqual(['captured-during-archive', 'retained-evidence']);
});

it('keeps the receipt invalid when capture during archival is followed by archive failure', async () => {
  const f = await setup();
  f.state.fail = 'archive';
  f.state.onArchive = async () => { await f.capture('capture-before-archive-failure'); };
  await expect(f.remove()).rejects.toMatchObject({ code: 'chats_not_saved' });
  expect((await f.adapter.readBinding(cleanupScope)).artifactsCollected).toBe(false);
  expect(f.state.running).toBe(false);
  expect(f.state.removed).toBe(false);
  expect((await f.source.list(cleanupBinding)).entries).toHaveLength(2);
  f.state.fail = null;
  await f.stop();
  expect((await f.artifacts.list(cleanupScope)).artifacts.map((entry) => entry.title).sort()).toEqual(['capture-before-archive-failure', 'retained-evidence']);
});

it('allows authoritative empty collection without guessing whether an omitted receipt is legacy', async () => {
  const f = await setup({ empty: true, binding: { state: 'stopped' } });
  await f.remove();
  expect(f.state.removed).toBe(true);
  expect(f.state.collects).toBe(2);
  expect((await f.artifacts.list(cleanupScope)).artifacts).toEqual([]);
});

it('collects a running producer again even when an older stopped run has a receipt', async () => {
  const f = await setup({ binding: { state: 'stopped', artifactsCollected: true } });
  f.state.running = true;
  await f.stop();
  expect(f.state.starts).toBe(0);
  expect(f.state.collects).toBe(1);
  expect((await f.artifacts.read(cleanupScope, f.reference.id)).artifact.id).toBe(f.reference.id);
});

it.each(['activity', 'transfer'])('stops temporary Stop recovery and keeps its source when %s fails', async (failure) => {
  const f = await setup();
  f.state.fail = failure;
  await expect(f.stop()).rejects.toThrow();
  expect(f.state.running).toBe(false);
  expect(f.state.gatekeeperRunning).toBe(false);
  expect(f.state.removed).toBe(false);
  expect((await f.adapter.readBinding(cleanupScope)).state).toBe('stopping');
});

it.each([
  { mode: 'open', domains: [], grants: [] },
  { mode: 'allowlist', domains: ['old.example.test'], grants: [] },
  { mode: 'allowlist', domains: [], grants: ['openai'] },
])('refuses a cold runtime whose gatekeeper retained policy %j', async (policy) => {
  const f = await setup();
  f.state.onStart = async () => { f.state.policy = policy; };
  await expect(f.remove()).rejects.toMatchObject({ code: 'space_cleanup_access_open' });
  expect(f.state.collects).toBe(0);
  expect(f.state.running).toBe(false);
  expect(f.state.removed).toBe(false);
});

it.each(['stop', 'remove'])('serializes %s with a login refresh already delivering its grant', async (operation) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await setup({ deliver: async () => { entered.resolve(); await release.promise; } });
  const grant = f.records.read(cleanupSpaceId).record.grants[0];
  const refresh = f.host.journey.sayLogin(cleanupSpaceId, grant, { methodID: grant.method, access: 'disposable', metadata: {} });
  await entered.promise;
  await expect(f[operation]()).rejects.toMatchObject({ code: 'space_busy' });
  expect(f.state.starts).toBe(0);
  release.resolve();
  expect(await refresh).toBe(true);
  await f[operation]();
  expect(f.state.running).toBe(false);
});

it.each(['stop', 'remove'])('holds the Spaces lifecycle lock throughout %s collection', async (operation) => {
  const f = await setup();
  f.state.onCollect = async () => {
    await expect(f.host.journey.startSpace(cleanupSpaceId)).rejects.toMatchObject({ code: 'space_busy' });
    await expect(f.host.journey.grantAccess(cleanupSpaceId, { kind: 'login', provider: 'openai' })).rejects.toMatchObject({ code: 'space_busy' });
    expect(await f.host.journey.sayLogin(cleanupSpaceId, f.records.read(cleanupSpaceId).record.grants[0], {})).toBeNull();
  };
  await f[operation]();
});

it.each(['stop', 'remove'])('clears protected MCP before %s startup and restores it only for a stopped retained Space', async (operation) => {
  const grant = { kind: 'mcp', id: 'mcp-jira', name: 'jira', connection: 'pmcp_0123456789abcdef' };
  const f = await setup({ kind: 'host', grants: [grant] });
  f.state.onStart = async () => { expect(f.state.subjectConnections).toEqual([]); };
  f.state.onCollect = async () => { expect(f.state.subjectConnections).toEqual([]); };
  await f[operation]();
  expect(f.state.subjectConnections).toEqual(operation === 'stop' ? [grant.connection] : []);
  expect(f.state.events.indexOf('clear-mcp')).toBeLessThan(f.state.events.indexOf('start'));
  if (operation === 'stop') expect(f.state.events.indexOf('restore-mcp')).toBeGreaterThan(f.state.events.lastIndexOf('stop'));
});

it('requires an acknowledged protected MCP suspension and never starts on a failed answer', async () => {
  const f = await setup({ kind: 'host', grants: [{ kind: 'mcp', id: 'mcp-jira', name: 'jira', connection: 'pmcp_0123456789abcdef' }] });
  f.state.subjectAnswers.push({ ok: false, code: 'protected_mcp_unavailable' });
  await expect(f.remove()).rejects.toMatchObject({ code: 'protected_mcp_unavailable' });
  expect(f.state.starts).toBe(0);
  expect(f.state.running).toBe(false);
  expect(f.state.removed).toBe(false);
});

it('restores protected MCP after a failed transfer only once the temporary producer is stopped', async () => {
  const grant = { kind: 'mcp', id: 'mcp-jira', name: 'jira', connection: 'pmcp_0123456789abcdef' };
  const f = await setup({ kind: 'host', grants: [grant] });
  f.state.fail = 'transfer';
  await expect(f.remove()).rejects.toThrow('Transfer failed');
  expect(f.state.subjectConnections).toEqual([grant.connection]);
  expect(f.state.events.slice(-2)).toEqual(['stop', 'restore-mcp']);
});

it('reports failed MCP restoration while leaving temporary execution stopped and source retained', async () => {
  const f = await setup({ kind: 'host', grants: [{ kind: 'mcp', id: 'mcp-jira', name: 'jira', connection: 'pmcp_0123456789abcdef' }] });
  f.state.subjectAnswers.push({ ok: true }, { ok: false, code: 'protected_mcp_unavailable' });
  await expect(f.stop()).rejects.toMatchObject({ code: 'protected_mcp_unavailable' });
  expect(f.state.running).toBe(false);
  expect(f.state.subjectConnections).toEqual([]);
  expect(f.records.read(cleanupSpaceId).status).toBe('ok');
});

it('preserves the transfer failure when MCP restoration also fails and keeps execution stopped', async () => {
  const f = await setup({ kind: 'host', grants: [{ kind: 'mcp', id: 'mcp-jira', name: 'jira', connection: 'pmcp_0123456789abcdef' }] });
  f.state.fail = 'transfer';
  f.state.subjectAnswers.push({ ok: true }, { ok: false, code: 'protected_mcp_unavailable' });
  await expect(f.remove()).rejects.toThrow('Transfer failed');
  expect(f.state.running).toBe(false);
  expect(f.state.subjectConnections).toEqual([]);
  expect(f.records.read(cleanupSpaceId).status).toBe('ok');
});

it('does not restart a producer that exits during archival after its first collection', async () => {
  const f = await setup();
  f.state.onArchive = async () => { f.exit(); };
  await expect(f.remove()).rejects.toMatchObject({ code: 'chats_not_saved' });
  expect(f.state.starts).toBe(1);
  expect(f.state.running).toBe(false);
  expect(f.state.removed).toBe(false);
});

it('refuses temporary startup when remembered access cannot be inspected', async () => {
  const f = await setup();
  f.records.remove(cleanupSpaceId);
  await expect(f.remove()).rejects.toMatchObject({ code: 'space_record_unreadable' });
  expect(f.state.starts).toBe(0);
  expect(f.state.removed).toBe(false);
});

it('keeps stopped root spaces behind their existing start confirmation', async () => {
  const f = await setup({ kind: 'host-root' });
  await expect(f.remove()).rejects.toMatchObject({ code: 'root_activation_required' });
  expect(f.state.starts).toBe(0);
  expect(f.state.removed).toBe(false);
});
