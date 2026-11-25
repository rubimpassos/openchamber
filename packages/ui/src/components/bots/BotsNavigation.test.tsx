import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import { botItem, botsConfig, configuredBot } from '@/lib/bots/bots.fixture';
import { botsConfigSchema } from '@/lib/bots/config';
import { deferred, installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const server = await serveSuggestedTasks((request) => handle(request));
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { BotsProject } = await import('./BotsProject');
const { BotItemDetail } = await import('./BotItemDetail');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const apis = createWebAPIs();
let root: Root;
let config = botsConfig();
const project = { id: 'project-1', path: '/repo' };
let saved = deferred<void>();
let wrote: z.infer<typeof botsConfigSchema> | null = null;
let conversationAsks = 0;
// A 1x1 JPEG header is enough for the client schema; the server inspects real bytes.
const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const archived = botItem({ id: 'item-old', title: 'Old repair', state: 'done', finishedAt: 2, sessions: { fixing: 'ses_old' } });

function handle(request: Request): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/bots/config') && request.method === 'PUT') return request.json().then((body) => {
    config = z.object({ config: botsConfigSchema }).parse(body).config;
    wrote = config;
    saved.resolve();
    return Response.json({ config });
  });
  if (path.endsWith('/conversation')) { conversationAsks += 1; return Response.json({}, { status: 503 }); }
  if (path.endsWith('/archive')) return Response.json({ items: [archived] });
  if (path.endsWith(`/items/${archived.id}`)) return Response.json({ item: archived, reports: {}, snapshot: null, sessionDirectories: { ses_old: '/repo' } });
  if (path.endsWith('/items/item-1')) return Response.json({ item: botItem(), reports: {}, snapshot: null });
  if (path.endsWith('/identities')) return Response.json({ identities: [] });
  if (path.endsWith('/bots')) return Response.json({ config, revision: 1, items: [botItem()], presets: [] });
  return Response.json({});
}

beforeEach(() => {
  config = botsConfig(); wrote = null; saved = deferred<void>(); conversationAsks = 0;
  useUIStore.getState().closeMainSurfaces();
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
    // Given a project with no bots.
    config.definitions = [];
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
    expect(wrote?.definitions).toHaveLength(1);
    expect(wrote?.definitions[0]).toMatchObject({ name: 'Parser bot', mission: 'Repair confirmed parser bugs', isolated: false, notify: 'attention' });
    saved = deferred<void>();
    await act(async () => button('Edit').click());
    await input('Mission', 'Repair and prove parser regressions');
    await act(async () => button('Save changes').click());
    await saved.promise;
    expect(wrote?.definitions[0]?.mission).toBe('Repair and prove parser regressions');
  });

  test('round-trips added and removed Discord channels through the bot form', async () => {
    // Given a bot with an existing exact destination.
    const retained = { guildId: '123456789012345678', channelId: '987654321098765432' };
    config.definitions = [{ ...configuredBot(), discord: { channels: [retained] } }];
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><BotsProject project={project} onLeave={() => {}} /></I18nProvider></RuntimeAPIContext.Provider>));
    await waitFor(() => !button('New bot').disabled);
    await act(async () => button('Edit').click());
    await act(async () => button('Execution').click());
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
    expect(wrote?.definitions[0]?.discord.channels).toEqual([{ guildId: '223456789012345678', channelId: '887654321098765432' }]);
    await act(async () => button('Edit').click());
    await act(async () => button('Execution').click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Server ID"]')?.value).toBe('223456789012345678');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Channel ID"]')?.value).toBe('887654321098765432');
  });

  test('keeps a bot photo through an unrelated edit and removes it on request', async () => {
    // Given a bot whose saved definition has a photo.
    config.definitions = [{ ...configuredBot(), avatar: photo }];
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
    expect(wrote?.definitions[0]?.avatar).toBe(photo);

    // When the user chooses initials.
    saved = deferred<void>();
    await act(async () => button('Edit').click());
    await act(async () => button('Use initials').click());
    await act(async () => button('Save changes').click());
    await saved.promise;
    await waitFor(() => document.body.textContent?.includes('Run now') === true);

    // Then the definition records the removal and the initials stand in.
    expect(wrote?.definitions[0]?.avatar).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  test('opens a bot page from the navigation and starts a demand for that bot', async () => {
    // Given two bots, the second of which has the listed work.
    config.definitions = [{ ...configuredBot(), id: 'bot-0', name: 'Docs bot' }, configuredBot()];
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
