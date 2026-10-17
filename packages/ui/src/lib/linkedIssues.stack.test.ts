import { describe, expect, test } from 'bun:test';
import { buildLinkedIssue, getLinkedIssues, withLinkedIssue } from './linkedIssues';
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
    const stored = withLinkedIssue({}, link, true);
    expect(getLinkedIssues(session(stored))).toEqual([link]);
  });
  test('keeps followStack when reattaching a PR with a fresh title', () => {
    const stored = withLinkedIssue({}, buildLinkedIssue({ ...input, followStack: true }), true);
    const refreshed = withLinkedIssue(stored, buildLinkedIssue({ ...input, title: 'Fresh' }), true);
    expect(getLinkedIssues(session(refreshed))[0]).toMatchObject({ title: 'Fresh', followStack: true });
  });
  test('allows explicitly disabling followStack without unlinking the PR', () => {
    const link = buildLinkedIssue({ ...input, followStack: true });
    const stored = withLinkedIssue({ openchamber: { linked_issues: [link] } }, { ...link, followStack: undefined }, true);
    expect(getLinkedIssues(session(stored))).toMatchObject([{ number: 7, followStack: undefined }]);
  });
  test('rejects a false or non-PR followStack entry while retaining unrelated valid links', () => {
    const valid = buildLinkedIssue(input);
    const metadata = { openchamber: { linked_issues: [{ ...valid, followStack: false }, { ...valid, kind: 'issue', followStack: true }, valid] } };
    expect(getLinkedIssues(session(metadata))).toEqual([valid]);
  });
});
