import { expect, it } from 'vitest';
import { createOpenChamberControlService } from './service.js';
import { assertBotLeadAction } from '../session-lead/bot-guidance.js';

const metadata = { openchamber: { lead: { at: 1 }, automation: {
  source: 'bot', role: 'conversation', projectId: 'project', botId: 'bot', itemId: 'item',
} } };
const setup = (registry = true) => {
  const effects = [];
  const records = new Map([['ses_lead', { id: 'ses_lead', metadata }], ['ses_other', { id: 'ses_other', metadata: {} }]]);
  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: async () => ({}), sanitizeProjects: () => [],
    buildOpenCodeUrl: () => 'http://controlled.invalid/api/info', getOpenCodeAuthHeaders: () => ({}),
    createClient: () => ({ session: { get: async ({ sessionID }) => records.get(sessionID) } }),
    sessionService: { send: async () => { effects.push('send'); return {}; } },
    scheduledTaskService: {},
    assertConversationControlTarget: registry ? async (action, sessionId) => { if (sessionId === 'ses_lead') assertBotLeadAction(action); } : undefined,
    workflowRuntime: { executeAction: async () => { effects.push('workflow'); } },
    leadActions: { execute: async () => ({ saved: true }) },
    artifacts: { capture: async (_input, context) => { effects.push(context); return null; } },
  });
  return { service, effects, records };
};

it.each(['session.send', 'workflow.run', 'schedule.create', 'lead.handover'])('refuses %s from the canonical Bot lead before effects', async (action) => {
  const f = setup(false);
  await expect(f.service.execute(action, { sessionId: 'ses_other', prompt: 'Bypass' }, '/project',
    { contextSessionId: 'ses_other', callerSessionId: 'ses_lead' })).rejects.toMatchObject({ statusCode: 403 });
  expect(f.effects).toEqual([]);
});

it('refuses another agent sending through generic control to the Bot lead', async () => {
  const f = setup();
  await expect(f.service.execute('session.send', { sessionId: 'ses_lead', prompt: 'Bypass' }, '/project',
    { callerSessionId: 'ses_other', contextSessionId: 'ses_other' })).rejects.toMatchObject({ statusCode: 403 });
  expect(f.effects).toEqual([]);
});

it('retains registered caller admission when its metadata marker disappears and it names another target', async () => {
  const f = setup();
  f.records.get('ses_lead').metadata = {};
  await expect(f.service.execute('session.send', { sessionId: 'ses_other', prompt: 'Bypass' }, '/project',
    { callerSessionId: 'ses_lead', contextSessionId: 'ses_other' })).rejects.toMatchObject({ statusCode: 403 });
  expect(f.effects).toEqual([]);
});

it('keeps brief and render actions available and passes authenticated origin into capture', async () => {
  const f = setup();
  expect(await f.service.execute('lead.brief', { brief: 'Goal' }, '/project', { contextSessionId: 'ses_lead' })).toEqual({ saved: true });
  expect(await f.service.execute('render.page', { ui: 'root = Text("Evidence")' }, '/project',
    { contextSessionId: 'ses_lead', contextCallId: 'call_page', contextMessageId: 'msg_page' })).toMatchObject({ shown: true });
  expect(f.effects).toEqual([{ sessionId: 'ses_lead', callId: 'call_page', messageId: 'msg_page', directory: '/project', signal: undefined }]);
});
