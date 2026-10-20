import { describe, expect, test } from 'bun:test';
import { buildLinkedIssue, getLinkedIssues } from './linkedIssues';
import type { Session } from './opencode/model';
import type { SessionMetadataRecord } from './sessionReviewMetadata';

const input = { url: 'https://github.com/acme/app/pull/7', number: 7, title: 'Feature', kind: 'pull' as const, linkedAt: 1 };
const session = (metadata: SessionMetadataRecord): Session => ({
  id: 'session-1', projectID: 'project-1', directory: '/repo', title: '', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 }, metadata,
});

describe('stack-following session links', () => {
  test('round-trips a stack-following PR through the metadata parser', () => {
    const link = buildLinkedIssue({ ...input, followStack: true });
    expect(getLinkedIssues(session({ openchamber: { linked_issues: [link] } }))).toEqual([link]);
  });
  test('leaves followStack absent on a PR that does not follow its stack', () => {
    expect('followStack' in buildLinkedIssue(input)).toBe(false);
  });
  test('rejects a false or non-PR followStack entry while retaining unrelated valid links', () => {
    const valid = buildLinkedIssue(input);
    const metadata = { openchamber: { linked_issues: [{ ...valid, followStack: false }, { ...valid, kind: 'issue', followStack: true }, valid] } };
    expect(getLinkedIssues(session(metadata))).toEqual([valid]);
  });
});
