import { expect, test } from 'bun:test';
import { toLinkedIssue, withComposerReferences, type ComposerReference } from './composerReferences';

test('whole-stack composer references retain the following anchor when recorded as session links', () => {
  const anchor: ComposerReference = { kind: 'change-request', provider: 'github', number: 2, title: 'Second',
    url: 'https://github.com/acme/app/pull/2', head: 'second', base: 'first', contextText: '', includeDiff: true, followStack: true };
  const attached = withComposerReferences([], [anchor]);
  expect(attached.map((reference) => toLinkedIssue(reference, 1))).toMatchObject([{ kind: 'pull', number: 2, followStack: true }]);
});
