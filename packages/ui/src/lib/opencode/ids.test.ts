import { expect, test } from 'bun:test'
import { Session } from '@opencode/schema/session'
import { createSessionId } from './ids'

test('places a local session ID between earlier and later official session IDs', () => {
  // Given the server generator on either side of a local creation.
  const before = Session.ID.create()
  const local = createSessionId()
  const after = Session.ID.create()
  // When a session list sorts by its official descending identity.
  const sorted = [before, local, after].sort()
  // Then the local record participates in the same ordering as server-created records.
  expect(sorted).toEqual([after, local, before])
})
