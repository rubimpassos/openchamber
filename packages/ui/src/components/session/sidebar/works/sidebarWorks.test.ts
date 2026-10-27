import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { buildSidebarWorkIndex, isInWorkZoneSession, orderSidebarWorks } from './sidebarWorks';
import { pickWorkSessionToOpen } from './workActions';

// SAFETY: works read only ids, forks and metadata.
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: id, directory: '/repo', time: { created: 1, updated: 1 }, ...extra } as Session);
const node = (id: string, children: SessionNode[] = [], extra: Partial<Session> = {}): SessionNode => ({ session: session(id, extra), children, worktree: null });
const group = (id: string, sessions: SessionNode[], worktree: boolean): SessionGroup => ({
  id, label: id, branch: worktree ? id : null, description: null, isMain: !worktree, directory: `/${id}`,
  worktree: worktree ? { path: `/${id}`, projectDirectory: '/repo', branch: id, label: id } : null,
  sessions,
});

const section: ProjectSection = {
  project: { id: 'p', normalizedPath: '/repo' },
  groups: [
    group('main', [node('root', [node('review')]), node('lonely')], false),
    group('wt', [node('w1'), node('w2')], true),
    group('empty-wt', [], true),
  ],
};

const openWork: Session['metadata'] = { openchamber: { work: { state: 'open' } } };
const priorityOpenWork: Session['metadata'] = { openchamber: { work: { state: 'open' }, priority: { at: 1 } } };
const doneWork: Session['metadata'] = { openchamber: { work: { state: 'done' } } };

describe('sidebar works', () => {
  test('a root session with what nests under it is one work, a worktree with all its sessions another', () => {
    const index = buildSidebarWorkIndex([section]);
    expect(index.bySessionId.get('review')?.key).toBe('session:root');
    expect(index.bySessionId.get('w2')?.key).toBe('p:wt');
    expect(index.worktreeWorks.map((ref) => ref.key)).toEqual(['p:wt', 'p:empty-wt']);
  });

  test('works come once each, in the order of their first matching session', () => {
    const index = buildSidebarWorkIndex([section]);
    const order = ['w2', 'review', 'w1', 'lonely', 'root'].map((id) => session(id));
    expect(orderSidebarWorks(order, index, (entry) => entry.id !== 'lonely').map((ref) => ref.key))
      .toEqual(['p:wt', 'session:root']);
  });

  test('omits a worktree from In work when only its priority session is in work', () => {
    // Given
    const index = buildSidebarWorkIndex([section]);
    const order = [session('w1', { metadata: priorityOpenWork }), session('w2', { metadata: doneWork })];
    const priorityIds = new Set(['w1']);

    // When
    const works = orderSidebarWorks(order, index, (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect(works.map((ref) => ref.key)).toEqual([]);
  });

  test('keeps a worktree in In work when another non-priority session is in work', () => {
    // Given
    const index = buildSidebarWorkIndex([section]);
    const order = [session('w1', { metadata: priorityOpenWork }), session('w2', { metadata: openWork })];
    const priorityIds = new Set(['w1']);

    // When
    const works = orderSidebarWorks(order, index, (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect(works.map((ref) => ref.key)).toEqual(['p:wt']);
  });

  test('orders In work by the first eligible non-priority member when a worktree has a priority session', () => {
    // Given
    const index = buildSidebarWorkIndex([section]);
    const order = [
      session('w1', { metadata: priorityOpenWork }),
      session('root', { metadata: openWork }),
      session('w2', { metadata: openWork }),
    ];
    const priorityIds = new Set(['w1']);

    // When
    const works = orderSidebarWorks(order, index, (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect(works.map((ref) => ref.key)).toEqual(['session:root', 'p:wt']);
  });

  test('restores ordinary In work classification when priority is switched off', () => {
    // Given
    const index = buildSidebarWorkIndex([section]);
    const priorityIds = new Set(['w1']);
    const before = orderSidebarWorks([session('w1', { metadata: priorityOpenWork })], index,
      (entry) => isInWorkZoneSession(entry, priorityIds));

    // When
    priorityIds.delete('w1');
    const after = orderSidebarWorks([session('w1', { metadata: openWork })], index,
      (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect({ before: before.map((ref) => ref.key), after: after.map((ref) => ref.key) })
      .toEqual({ before: [], after: ['p:wt'] });
  });

  test('omits priority root sessions from In work while retaining ordinary root sessions', () => {
    // Given
    const index = buildSidebarWorkIndex([section]);
    const order = [session('root', { metadata: priorityOpenWork }), session('lonely', { metadata: openWork })];
    const priorityIds = new Set(['root']);

    // When
    const works = orderSidebarWorks(order, index, (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect(works.map((ref) => ref.key)).toEqual(['session:lonely']);
  });

  test('keeps nested non-subagent work eligible while ignoring subagents, archived and inactive sessions', () => {
    // Given
    const review = node('review', [], { metadata: openWork });
    const root = node('root', [review], { metadata: doneWork });
    const subagent = node('subagent', [], { parentID: 'done', metadata: openWork });
    const done = node('done', [subagent], { metadata: doneWork });
    const archived = node('archived', [], { metadata: openWork, time: { created: 1, updated: 1, archived: 2 } });
    const plain = node('plain');
    const index = buildSidebarWorkIndex([{
      project: section.project,
      groups: [group('main', [root, plain], false), group('wt', [done, archived], true)],
    }]);
    const order = [subagent.session, archived.session, done.session, plain.session, review.session, root.session];
    const priorityIds = new Set<string>();

    // When
    const works = orderSidebarWorks(order, index, (entry) => isInWorkZoneSession(entry, priorityIds));

    // Then
    expect(works.map((ref) => ref.key)).toEqual(['session:root']);
  });

  test('a click opens the latest session that is not a review or fork, else the latest, else nothing', () => {
    const review = node('review', [], { metadata: { openchamber: { kind: 'review', originalSessionID: 'x' } } });
    // SAFETY: only the fork's source id is read.
    const fork = node('fork', [], { fork: { sessionID: 'x' } as Session['fork'] });
    expect(pickWorkSessionToOpen([review, fork, node('work')])?.id).toBe('work');
    expect(pickWorkSessionToOpen([review, fork])?.id).toBe('review');
    expect(pickWorkSessionToOpen([])).toBeNull();
  });
});
