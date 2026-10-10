import { expect, test } from 'bun:test';
import type { LoopbackContribution } from '@openchamber/sdk';
import { guestNeedsApproval, isGuestActive } from './capabilities';
import { parseGuestCatalogJson } from './parse';

const declaration = {
  port: 8123, env: 'OC_TEST_PORT', routes: [{ path: '/state', methods: ['GET'] }],
} satisfies LoopbackContribution;
const guest = { id: 'local-api', name: 'Local API', icon: 'plug', capabilities: { requested: ['loopback'], granted: [] } };

test('keeps resolution and lifecycle fields when parsing a server catalog', () => {
  // Given a server-resolved target, distinct from the declared default.
  const row = { ...guest, loopback: { ...declaration, status: 'ready', resolvedPort: 9123 }, panelBadge: 'count', backgroundEntry: 'index.html', backgroundStart: 'automatic' };
  // When parsing the network payload.
  const parsed = parseGuestCatalogJson(JSON.stringify({ guests: [row] }))?.guests;
  // Then approval and lifecycle consumers receive the authoritative values.
  expect(parsed).toEqual([row]);
});

test('keeps invalid configuration visible and inactive when approval is required', () => {
  // Given an invalid server environment and no effective grant.
  const row = { ...guest, loopback: { ...declaration, status: 'config-invalid' } };
  // When the catalog is parsed for Settings.
  const [parsed] = parseGuestCatalogJson(JSON.stringify({ guests: [row] }))?.guests ?? [];
  // Then the extension remains visible for review, not an active guest.
  expect(parsed).toEqual(row);
  if (!parsed) throw new Error('Expected an installed guest');
  expect(guestNeedsApproval(parsed)).toBe(true);
  expect(isGuestActive(parsed)).toBe(false);
});

for (const loopback of [
  { ...declaration, status: 'ready' },
  { ...declaration, status: 'ready', resolvedPort: 80 },
  { ...declaration, status: 'config-invalid', resolvedPort: 8123 },
  { ...declaration, status: 'unknown' },
  { ...declaration, status: 'ready', resolvedPort: 8123, routes: [{ path: '/../secret', methods: ['GET'] }] },
]) {
  test(`rejects contradictory or malformed server resolution ${JSON.stringify(loopback)}`, () => {
    // Given a response with no valid target state.
    const json = JSON.stringify({ guests: [{ ...guest, loopback }] });
    // When parsing the trust boundary.
    const parsed = parseGuestCatalogJson(json);
    // Then the row is listed as unreadable, never as an installed guest.
    expect(parsed?.guests).toEqual([]);
    expect(parsed?.unreadable).toEqual([{ id: guest.id, name: guest.name, builtIn: false }]);
  });
}
