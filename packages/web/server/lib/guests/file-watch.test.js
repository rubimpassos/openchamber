import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createGuestFileWatchRegistry, resolveWatchPaths } from './file-watch.js';

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fw-'));
  fs.mkdirSync(path.join(root, '.omo', 'v2-state'), { recursive: true });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const until = async (check, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

describe('guest file watches', () => {
  it('reports a write to a watched file by the path the guest named, and nothing for other files', async () => {
    const root = project();
    const events = [];
    const registry = createGuestFileWatchRegistry({ emit: (event) => events.push(event), debounceMs: 10 });
    cleanups.push(() => registry.stop());
    const files = resolveWatchPaths(root, ['.omo/v2-state/todos.json']);
    const watchId = registry.watch({ guestId: 'omo', files });

    fs.writeFileSync(path.join(root, '.omo', 'v2-state', 'other.json'), '{}');
    fs.writeFileSync(path.join(root, '.omo', 'v2-state', 'todos.json'), '{"a":1}');
    expect(await until(() => events.length > 0)).toBe(true);
    expect(events[0]).toEqual({ guestId: 'omo', watchId, paths: ['.omo/v2-state/todos.json'] });
  });

  it('refuses paths outside the project', () => {
    const root = project();
    expect(resolveWatchPaths(root, ['../escape.json'])).toBeNull();
    expect(resolveWatchPaths(root, ['/etc/passwd'])).toBeNull();
    expect(resolveWatchPaths(root, ['~/x'])).toBeNull();
    expect(resolveWatchPaths(root, ['a/b.json'])).toHaveLength(1);
  });

  it('a renewed watch keeps its id; an expired or removed one stops reporting', async () => {
    const root = project();
    let clock = 0;
    const events = [];
    const registry = createGuestFileWatchRegistry({ emit: (event) => events.push(event), now: () => clock, leaseMs: 1_000, debounceMs: 10 });
    cleanups.push(() => registry.stop());
    const files = resolveWatchPaths(root, ['.omo/v2-state/todos.json']);
    const watchId = registry.watch({ guestId: 'omo', files });
    expect(registry.watch({ guestId: 'omo', files, watchId })).toBe(watchId);
    expect(registry.watch({ guestId: 'other', files, watchId })).not.toBe(watchId);
    expect(registry.unwatch({ guestId: 'other', watchId })).toBe(false);

    // Both leases ran out: the next call sweeps them, only the new watch stays.
    clock = 5_000;
    registry.watch({ guestId: 'omo', files: [] });
    expect(registry.size()).toBe(1);
    registry.closeGuest('omo');
    registry.closeGuest('other');
    expect(registry.size()).toBe(0);
  });

  it('starts watching a directory that appears later, on the next renew', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fw-late-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const registry = createGuestFileWatchRegistry({ emit: (event) => events.push(event), debounceMs: 10 });
    cleanups.push(() => registry.stop());
    const files = resolveWatchPaths(root, ['.omo/v2-state/todos.json']);
    const watchId = registry.watch({ guestId: 'omo', files });
    fs.mkdirSync(path.join(root, '.omo', 'v2-state'), { recursive: true });
    registry.watch({ guestId: 'omo', files, watchId });
    fs.writeFileSync(path.join(root, '.omo', 'v2-state', 'todos.json'), '{}');
    expect(await until(() => events.length > 0)).toBe(true);
  });
});
