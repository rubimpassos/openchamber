import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import { botItem, configuredBot } from '@/lib/bots/bots.fixture';
import { botDefinitionSchema, type BotDefinition } from '@/lib/bots/config';
import { botConfigI18n } from '@/lib/i18n/messages/bot-config.i18n';
import { clickSuggestedTasksControl, deferred, installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const project = { id: 'project-1', path: '/repo', label: 'Parser' };
const registered = [project, { id: 'project-2', path: '/srv/manual', label: 'Docs' }];
const server = await serveSuggestedTasks((request) => handle(request), { projects: registered, activeProjectId: project.id });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { BotsProject } = await import('./BotsProject');
const { BotItemDetail } = await import('./BotItemDetail');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const apis = createWebAPIs();
const copy = botConfigI18n.en;
let root: Root;
/** A bot that may work in the shown project. */
const member = (patch: Partial<BotDefinition> = {}): BotDefinition => ({ ...configuredBot(), projects: { [project.id]: 'merge' }, ...patch });
let bots: BotDefinition[] = [member()];
let presets: BotDefinition[] = [];
let revision = 1;
let changedElsewhere = false;
let saved = deferred<void>();
let reread = deferred<void>();
let wrote: BotDefinition[] | null = null;
let settingsWrite: z.infer<typeof json> | null = null;
let conversationAsks = 0;
const json = z.json();
const globalEdit = z.object({ definitions: z.array(botDefinitionSchema), expectedRevision: z.number().int() }).strict();
// A 1x1 JPEG header is enough for the client schema; the server inspects real bytes.
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const archived = botItem({ id: 'item-old', title: 'Old repair', state: 'done', finishedAt: 2, sessions: { fixing: 'ses_old' } });

function handle(request: Request): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  const projectBots = () => bots.filter((bot) => bot.projects[project.id] !== undefined);
  if (path === '/api/bots' && request.method === 'PUT') return request.json().then((body) => {
    const edit = globalEdit.parse(body);
    if (changedElsewhere || edit.expectedRevision !== revision) {
      changedElsewhere = false; revision += 1;
      return Response.json({ code: 'BOT_DEFINITIONS_CHANGED', error: 'Bot definitions changed' }, { status: 409 });
    }
    bots = edit.definitions; wrote = bots; revision += 1;
    saved.resolve();
    return Response.json({ revision, definitions: bots, presets });
  });
  if (path === '/api/bots') { if (revision > 1) reread.resolve(); return Response.json({ revision, definitions: bots, presets }); }
  if (path.endsWith('/bots/config') && request.method === 'PUT') return request.json().then((body) => {
    settingsWrite = json.parse(body);
    saved.resolve();
    return Response.json({ config: { concurrency: 2, retentionDays: 90, definitions: projectBots() } });
  });
  if (path.endsWith('/conversation')) { conversationAsks += 1; return Response.json({}, { status: 503 }); }
  if (path.endsWith('/archive')) return Response.json({ items: [archived] });
  if (path.endsWith(`/items/${archived.id}`)) return Response.json({ item: archived, reports: {}, snapshot: null, sessionDirectories: { ses_old: '/repo' } });
  if (path.endsWith('/items/item-1')) return Response.json({ item: botItem(), reports: {}, snapshot: null });
  if (path.endsWith('/identities')) return Response.json({ identities: [{ id: 'jira-1', revision: 1, kind: 'jira-service', configured: true, label: 'Jira triage' }] });
  if (path.endsWith('/bots')) return Response.json({ config: { concurrency: 2, retentionDays: 90, definitions: projectBots() }, revision: 1, items: [botItem()], presets: [] });
  return Response.json({});
}

beforeEach(() => {
  bots = [member()]; presets = []; revision = 1; changedElsewhere = false; wrote = null; settingsWrite = null;
  saved = deferred<void>(); reread = deferred<void>(); conversationAsks = 0;
  useUIStore.getState().closeMainSurfaces();
  useProjectsStore.setState({ projects: registered, activeProjectId: project.id });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); useUIStore.getState().closeMainSurfaces(); });
afterAll(async () => { await server.stop(true); await dom.restore(); });

const button = (label: string) => {
  const element = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return element;
};
const waitFor = async (read: () => boolean) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (read()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error('Expected UI state did not appear');
};
const input = async (label: string, value: string) => {
  const element = document.querySelector(`[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) throw new Error(`Missing input: ${label}`);
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native value setter');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
};
const until = (ready: () => boolean) => {
  if (ready()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(); } });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  });
};
const choose = async (label: string, option: string) => {
  const trigger = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!trigger) throw new Error(`Missing select: ${label}`);
  await clickSuggestedTasksControl(trigger);
  // A closed select keeps its options mounted, so the open one's are the last in the document.
  const entry = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((element) => element.textContent === option).pop();
  if (!entry) throw new Error(`Missing option: ${option}`);
  await clickSuggestedTasksControl(entry);
};
const value = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)?.value;
/** Opens the first bot's editor in the real page, with the providers its project and connector rows read. */
const openEditor = async () => {
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><ThemeSystemProvider><I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider></ThemeSystemProvider></RuntimeAPIContext.Provider>));
  await until(() => [...document.querySelectorAll('button')].some((entry) => entry.textContent === 'Edit'));
  await act(async () => button('Edit').click());
};
const save = async () => { await act(async () => { button('Save changes').click(); await saved.promise; }); };

describe('Bots navigation and forms', () => {
  test('opens other main surfaces in one transition and retires the bot target', () => {
    // Given Bots is open with a one-shot item target.
    const openers = [
      () => useUIStore.getState().setScheduledTasksDialogOpen(true),
      () => useUIStore.getState().setSuggestedTasksPageOpen(true),
      () => useUIStore.getState().setArchivePageOpen(true),
      () => useUIStore.getState().setIntegrationsCatalogOpen(true),
      () => useUIStore.getState().setUsageStatsPageOpen(true),
      () => useUIStore.getState().setSourceBoardOpen(true),
      () => useUIStore.getState().setWorktreesPageProjectId(project.id),
      () => useUIStore.getState().setSpacesPageProjectId(project.id),
      () => useUIStore.getState().setOpenGuestPage('guest'),
      () => useUIStore.getState().setRunOverviewKey('run'),
    ];
    for (const open of openers) {
      useUIStore.getState().setBotsPageTarget({ projectId: project.id, itemId: 'item-1' });
      useUIStore.getState().setBotsPageOpen(true);
      let transitions = 0;
      const release = useUIStore.subscribe(() => { transitions += 1; });

      // When another main surface opens.
      open(); release();

      // Then no intermediate closed-all state is published and no target leaks into a later visit.
      expect(transitions).toBe(1);
      expect(useUIStore.getState().isBotsPageOpen).toBe(false);
      expect(useUIStore.getState().botsPageTarget).toBeNull();
    }
  });

  test('creates and edits a bot through the actual form and HTTP boundary', async () => {
    // Given a server with no bots.
    bots = [];
    await act(async () => root.render(<I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider>));
    await waitFor(() => !button('New bot').disabled);
    await act(async () => button('New bot').click());
    await input('Name', 'Parser bot');
    await input('Mission', 'Repair confirmed parser bugs');

    // When the user explicitly saves the form.
    await act(async () => button('Save changes').click());
    await saved.promise;
    await waitFor(() => document.body.textContent?.includes('Parser bot') === true && document.body.textContent.includes('Run now'));

    // Then the server receives all defaults and the saved bot can be edited.
    expect(wrote).toHaveLength(1);
    expect(wrote?.[0]).toMatchObject({ name: 'Parser bot', mission: 'Repair confirmed parser bugs', isolated: false, notify: 'attention' });
    saved = deferred<void>();
    await act(async () => button('Edit').click());
    await input('Mission', 'Repair and prove parser regressions');
    await act(async () => button('Save changes').click());
    await saved.promise;
    expect(wrote?.[0]?.mission).toBe('Repair and prove parser regressions');
  });

  test('round-trips added and removed Discord channels through the bot form', async () => {
    // Given a bot with an existing exact destination.
    const retained = { guildId: '123456789012345678', channelId: '987654321098765432' };
    bots = [member({ discord: { channels: [retained] } })];
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider></RuntimeAPIContext.Provider>));
    await waitFor(() => !button('New bot').disabled);
    await act(async () => button('Edit').click());
    await act(async () => button('Connectors').click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Channel ID"]')?.value).toBe(retained.channelId);
    await act(async () => button('Remove channel').click());
    await act(async () => button('Add channel').click());
    await input('Server ID', '223456789012345678');
    await input('Channel ID', '887654321098765432');

    // When the user saves the replacement list.
    await act(async () => button('Save changes').click());
    await saved.promise;
    await waitFor(() => document.body.textContent?.includes('Run now') === true);

    // Then the HTTP write contains only the chosen destination and reopening retains it.
    expect(wrote?.[0]?.discord.channels).toEqual([{ guildId: '223456789012345678', channelId: '887654321098765432' }]);
    await act(async () => button('Edit').click());
    await act(async () => button('Connectors').click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Server ID"]')?.value).toBe('223456789012345678');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Channel ID"]')?.value).toBe('887654321098765432');
  });

  test('keeps a bot photo through an unrelated edit and removes it on request', async () => {
    // Given a bot whose saved definition has a photo.
    bots = [member({ avatar: photo })];
    await act(async () => root.render(<I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider>));
    await waitFor(() => !button('New bot').disabled);
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();

    // When the mission changes and the form is saved.
    await act(async () => button('Edit').click());
    await input('Mission', 'Maintain the repository carefully');
    await act(async () => button('Save changes').click());
    await saved.promise;
    await waitFor(() => document.body.textContent?.includes('Run now') === true);

    // Then the photo is written back with the definition.
    expect(wrote?.[0]?.avatar).toBe(photo);

    // When the user chooses initials.
    saved = deferred<void>();
    await act(async () => button('Edit').click());
    await act(async () => button('Use initials').click());
    await act(async () => button('Save changes').click());
    await saved.promise;
    await waitFor(() => document.body.textContent?.includes('Run now') === true);

    // Then the definition records the removal and the initials stand in.
    expect(wrote?.[0]?.avatar).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  test('writes the access chosen per project and warns while a bot has none', async () => {
    // Given a bot with no access to any registered project.
    bots = [configuredBot()];
    await openEditor();
    expect(document.body.textContent).toContain(copy['bots.config.noProjects']);
    await act(async () => button('Projects').click());

    // When the user gives it a different access in each project and saves.
    await choose('Access to Parser', 'Fix and open PR');
    await choose('Access to Docs', 'Read only');
    expect(document.body.textContent).not.toContain(copy['bots.config.noProjects']);
    await save();

    // Then the global list holds exactly those two scopes.
    expect(wrote?.[0]?.projects).toEqual({ 'project-1': 'pr', 'project-2': 'read' });

    // When one project's access is taken away again.
    saved = deferred<void>();
    await until(() => [...document.querySelectorAll('button')].some((entry) => entry.textContent === 'Edit'));
    await act(async () => button('Edit').click());
    await act(async () => button('Projects').click());
    await choose('Access to Docs', 'No access');
    await save();

    // Then that project is absent, which is how the server reads no access.
    expect(wrote?.[0]?.projects).toEqual({ 'project-1': 'pr' });
  });

  test('shows each connector with its kind and what the bot does without it', async () => {
    // Given a bot that acts in Jira under its own identity and uses one MCP server's tools.
    bots = [member({ identity: { jira: { identityId: 'jira-1' } }, mcp: [{ server: 'sentry', tools: { search: 'allow' } }] })];
    await openEditor();

    // When the Connectors tab opens.
    await act(async () => button('Connectors').click());
    await until(() => document.querySelector('[role="combobox"][aria-label="Jira identity"]')?.textContent === 'Jira triage');

    // Then both kinds are labelled and each card says what is lost without it; GitHub is not listed yet.
    const text = () => document.body.textContent ?? '';
    for (const key of ['bots.config.connectors.kind.identity', 'bots.config.connectors.jira.without', 'bots.config.connectors.kind.mcp', 'bots.config.connectors.mcp.without'] as const) expect(text()).toContain(copy[key]);
    expect(text()).not.toContain(copy['bots.config.connectors.github.without']);

    // When GitHub is added from the connector menu and Jira is removed.
    await act(async () => button('Connector').click());
    const github = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent === 'GitHub');
    if (!github) throw new Error('Missing GitHub connector choice');
    await act(async () => github.click());
    expect(text()).toContain(copy['bots.config.connectors.github.without']);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove Jira"]')?.click());
    await save();

    // Then the Jira identity is gone from the saved bot and its MCP rules are untouched.
    expect(wrote?.[0]?.identity.jira).toBeUndefined();
    expect(wrote?.[0]?.mcp).toEqual([{ server: 'sentry', tools: { search: 'allow' } }]);
  });

  test('keeps a saved artifact ID through a relabel and derives new IDs from their labels', async () => {
    // Given a bot with one saved artifact.
    bots = [member({ artifacts: [{ id: 'regression', label: 'A regression test' }] })];
    await openEditor();

    // When it is relabelled and two artifacts with the same label are added.
    await input('Artifact 1', 'A test that fails before the fix');
    for (const row of ['Artifact 2', 'Artifact 3']) {
      await act(async () => button('Add artifact').click());
      await input(row, 'Screenshot of the fixed screen');
    }
    await save();

    // Then the saved ID is unchanged and the new ones are unique slugs of their labels.
    expect(wrote?.[0]?.artifacts).toEqual([
      { id: 'regression', label: 'A test that fails before the fix' },
      { id: 'screenshot-of-the-fixed-screen', label: 'Screenshot of the fixed screen' },
      { id: 'screenshot-of-the-fixed-screen-2', label: 'Screenshot of the fixed screen' },
    ]);
  });

  test('starts a bot from a preset with the artifacts the preset suggests', async () => {
    // Given the server offers a preset that names its proof.
    bots = [];
    presets = [{ ...configuredBot(), id: 'jira-bugs', artifacts: [{ id: 'regression', label: 'A regression test that fails before the fix' }] }];
    await act(async () => root.render(<I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider>));
    await until(() => [...document.querySelectorAll('button')].some((entry) => entry.textContent === 'Jira bugs'));

    // When the preset is chosen.
    await act(async () => button('Jira bugs').click());

    // Then the new bot's form already lists that artifact.
    expect(value('Artifact 1')).toBe('A regression test that fails before the fix');
  });

  test('keeps the draft and says what happened when the bot list changed elsewhere', async () => {
    // Given an edited bot whose list another client rewrites before the save.
    await openEditor();
    await input('Mission', 'Repair parser regressions only');
    changedElsewhere = true;

    // When the user saves.
    await act(async () => button('Save changes').click());
    await until(() => document.querySelector('[role="alert"]')?.textContent === botConfigI18n.en['bots.requestError.changed']);
    await reread.promise;

    // Then nothing was written, the draft is still in the form, and no server text or code is shown.
    expect(wrote).toBeNull();
    expect(value('Mission')).toBe('Repair parser regressions only');
    expect(document.body.textContent).not.toContain('BOT_DEFINITIONS_CHANGED');
    expect(document.body.textContent).not.toContain('Bot definitions changed');
  });

  test('saves the project limits without sending the bot list', async () => {
    // Given the project settings are open on the overview.
    await act(async () => root.render(<I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider>));
    await waitFor(() => !button('New bot').disabled);
    await act(async () => button('Configure').click());

    // When the user saves them.
    await save();

    // Then the request carries only the two limits, so no bot's access can change with it.
    expect(settingsWrite).toEqual({ config: { concurrency: 2, retentionDays: 90 } });
    expect(wrote).toBeNull();
  });

  test('opens a bot page from the navigation and starts a demand for that bot', async () => {
    // Given two bots, the second of which has the listed work.
    bots = [{ ...configuredBot(), id: 'bot-0', name: 'Docs bot' }, member()];
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider></RuntimeAPIContext.Provider>));
    await waitFor(() => !button('New bot').disabled);

    // When its row in the bot navigation is opened.
    const row = document.querySelector<HTMLButtonElement>('nav button[title="Repository bot"]');
    await act(async () => row?.click());

    // Then the page names the bot, its purpose and its work, and marks it current.
    expect(row?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('h2')?.textContent).toBe('Repository bot');
    expect(document.body.textContent).toContain('Maintain the repository');
    expect(document.body.textContent).toContain('Repair parser');

    // When a demand starts from that page.
    const start = [...document.querySelectorAll('button')].filter((entry) => entry.textContent === 'New demand' && !entry.closest('nav'))[0];
    await act(async () => start?.click());

    // Then the form already names this bot.
    expect(document.querySelector('button[aria-label="Bots"]')?.textContent).toContain('Repository bot');
  });

  test('opens an ended item that has only stage sessions as its record', async () => {
    // Given an archived item from before conversations existed.
    await act(async () => root.render(<I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider>));
    await waitFor(() => !button('New bot').disabled);
    await act(async () => button('Archive').click());
    await waitFor(() => document.body.textContent?.includes('Old repair') === true);

    // When it opens.
    await act(async () => button('Old repair').click());
    await waitFor(() => !button('ses_old').disabled);

    // Then its stage session stays reachable at the server's address and no conversation is asked for.
    expect(document.body.textContent).toContain('Stage sessions');
    expect(conversationAsks).toBe(0);
  });

  test('opens the exact managed bot target once', async () => {
    // Given a managed scheduled row points to this bot.
    useUIStore.getState().setBotsPageTarget({ projectId: project.id, botId: configuredBot().id });
    const Harness = () => {
      const target = useUIStore((state) => state.botsPageTarget);
      return <BotsProject project={project} onLeave={() => {}} initialBotId={target?.botId} />;
    };
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    await waitFor(() => document.querySelector('input[aria-label="Name"]') !== null);
    expect(useUIStore.getState().botsPageTarget).toBeNull();

    // When the user leaves the editor and refreshes the page.
    await act(async () => button('Back').click());
    const refresh = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
    await act(async () => refresh?.click());
    await waitFor(() => !refresh?.disabled);

    // Then the consumed target does not reopen the editor.
    expect(document.querySelector('input[aria-label="Name"]')).toBeNull();
  });

  test('keeps recorded waits visible for archived terminal items', async () => {
    // Given a stopped archived item retains the reason it waited.
    const item = botItem({ state: 'stopped', finishedAt: 2, wait: { reason: 'Awaiting a repository owner', since: 1, channel: 'github', people: ['owner'] } });

    // When its archive detail opens.
    await act(async () => root.render(<I18nProvider><BotItemDetail projectId={project.id} initial={item} archived onBack={() => {}} onLeave={() => {}} /></I18nProvider>));

    // Then the wait is readable without exposing live mutation controls.
    expect(document.body.textContent).toContain('Awaiting a repository owner');
    expect(document.body.textContent).not.toContain('Stop item');
  });
});
