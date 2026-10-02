import { describe, expect, test } from 'bun:test';

import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import type { Session } from '@/lib/opencode/model';
import { goalDriverName } from './goal-driver';
import type { InstalledGuest } from './types';

const omo: InstalledGuest = {
  id: 'omo', name: 'Oh-My-OpenAgent', icon: 'robot-2', enabled: true,
  capabilities: { requested: [], granted: [] }, goal: { driver: 'omo' },
};

describe('goal drivers', () => {
  test('a goal names its driver, and the driver resolves to the enabled extension declaring it', () => {
    const session = { metadata: { openchamber: { goal: { id: 'g', objective: 'ship', status: 'active', driver: 'omo' } } } } as unknown as Session;
    expect(getSessionGoal(session)?.driver).toBe('omo');
    expect(goalDriverName([omo], 'omo')).toBe('Oh-My-OpenAgent');
  });

  test('a paused extension or an unknown driver hands the goal back to OpenChamber', () => {
    expect(goalDriverName([{ ...omo, enabled: false }], 'omo')).toBeNull();
    expect(goalDriverName([omo], 'other')).toBeNull();
    expect(goalDriverName([omo], null)).toBeNull();
  });
});
