import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_CENTER_LIMIT,
  NOTIFICATION_CENTER_TTL_MS,
  createNotificationCenterPersistence,
  createNotificationCenterRuntime,
} from './center.js';
import { registerNotificationCenterRoutes } from './center-routes.js';

const ready = (overrides = {}) => ({
  kind: 'ready',
  priority: 'normal',
  delivery: 'delivered',
  title: 'Build agent is ready',
  body: 'Done',
  sessionId: 'ses_1',
  directory: '/repo',
  sessionName: 'Fix the header',
  ...overrides,
});

const memoryPersistence = (initial = []) => {
  const saved = [];
  return { saved, load: vi.fn(async () => initial), save: vi.fn(async (entries) => { saved.push(entries); }) };
};

const makeCenter = ({ initial, time = 1_000 } = {}) => {
  const persistence = memoryPersistence(initial);
  const broadcast = vi.fn();
  let clock = time;
  let id = 0;
  const center = createNotificationCenterRuntime({
    persistence,
    broadcast,
    now: () => clock,
    createId: () => `n${(id += 1)}`,
    saveDelayMs: 0,
  });
  return { center, persistence, broadcast, advance: (ms) => { clock += ms; } };
};

const tempDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('notification center runtime', () => {
  it('records unread entries, lists them newest first and broadcasts each one', async () => {
    const { center, broadcast, advance } = makeCenter();

    await center.record(ready({ title: 'first' }));
    advance(10);
    const second = await center.record(ready({ kind: 'permission', priority: 'high', title: 'second', sessionName: '' }));

    expect(second).toMatchObject({ id: 'n2', readAt: null, verdict: null, sessionName: null, createdAt: 1_010 });
    expect((await center.list()).map((entry) => entry.title)).toEqual(['second', 'first']);
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'openchamber:notification-center.changed',
      properties: { change: 'added', entry: second },
    });
  });

  it('marks read by ids, by session or all, and reports only what changed', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.record(ready({ sessionId: 'ses_2' }));
    await center.record(ready({ sessionId: 'ses_2' }));

    expect((await center.markRead({ ids: ['n1'] })).ids).toEqual(['n1']);
    expect((await center.markRead({ sessionId: 'ses_2' })).ids).toEqual(['n2', 'n3']);
    broadcast.mockClear();
    expect((await center.markRead({ all: true })).ids).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    expect((await center.list()).every((entry) => entry.readAt !== null)).toBe(true);
  });

  it('keeps at most the limit and drops entries past the retention', async () => {
    const old = { ...ready(), id: 'old', createdAt: 0, verdict: null, readAt: null };
    const { center } = makeCenter({ initial: [old], time: NOTIFICATION_CENTER_TTL_MS + 1 });
    expect(await center.list()).toEqual([]);

    for (let index = 0; index < NOTIFICATION_CENTER_LIMIT + 5; index += 1) await center.record(ready());
    const entries = await center.list();
    expect(entries).toHaveLength(NOTIFICATION_CENTER_LIMIT);
    expect(entries.at(-1).id).toBe('n6');
  });

  it('clears everything and tells every client', async () => {
    const { center, broadcast } = makeCenter();
    await center.record(ready());
    await center.clear();
    expect(await center.list()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith({ type: 'openchamber:notification-center.changed', properties: { change: 'cleared' } });
  });

  it('starts empty when the saved file cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const center = createNotificationCenterRuntime({
      persistence: { load: async () => { throw new Error('EACCES'); }, save: async () => {} },
    });
    expect(await center.list()).toEqual([]);
  });
});

describe('notification center persistence', () => {
  it('round-trips entries, drops broken ones and reads a missing or foreign file as empty', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-center-'));
    tempDirs.push(dataDir);
    const persistence = createNotificationCenterPersistence({ dataDir });
    expect(await persistence.load()).toEqual([]);

    const entry = { ...ready(), id: 'n1', createdAt: 5, verdict: 'review', readAt: null };
    await persistence.save([entry, { id: 'broken' }]);
    expect(await persistence.load()).toEqual([entry]);
    expect((await fs.stat(path.join(dataDir, 'notification-center.json'))).mode & 0o777).toBe(0o600);

    await fs.writeFile(path.join(dataDir, 'notification-center.json'), JSON.stringify({ version: 99, entries: [entry] }));
    expect(await persistence.load()).toEqual([]);
  });
});

describe('notification center routes', () => {
  const appWith = (center) => {
    const app = express();
    registerNotificationCenterRoutes(app, { notificationCenter: center });
    return app;
  };

  it('lists, marks read and clears', async () => {
    const { center } = makeCenter();
    await center.record(ready());
    const app = appWith(center);

    const listed = await request(app).get('/api/notification-center').expect(200);
    expect(listed.body.entries).toHaveLength(1);
    const read = await request(app).post('/api/notification-center/read').send({ sessionId: 'ses_1' }).expect(200);
    expect(read.body.ids).toEqual(['n1']);
    await request(app).delete('/api/notification-center').expect(200);
    expect((await request(app).get('/api/notification-center')).body.entries).toEqual([]);
  });

  it('rejects a read with no target or more than one', async () => {
    const app = appWith(makeCenter().center);
    await request(app).post('/api/notification-center/read').send({}).expect(400);
    await request(app).post('/api/notification-center/read').send({ all: true, sessionId: 'ses_1' }).expect(400);
    await request(app).post('/api/notification-center/read').send({ ids: [] }).expect(400);
  });
});
