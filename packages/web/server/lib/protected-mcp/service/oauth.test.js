import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { destinationFingerprint, parseDefinition } from './definitions.js';
import { createOAuth } from './oauth.js';
import { openStore } from './store.js';
import { startHttpFixture } from '../test-support/http-fixture.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DEFINITION = { name: 'remote', transport: 'http', http: { url: 'https://mcp.example.com/mcp', oauth: { scopes: [] } } };
const refreshed = () => new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
const refused = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });

/**
 * A connection with an expired grant and an authorization server whose token
 * answer waits until the test releases it, so the test can change the
 * connection while a refresh is on the wire.
 */
async function setup({ answer = refreshed } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-mcp-oauth-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const clock = 1_000_000;
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(() => store.close());
  const { connection: created } = await store.apply({ kind: 'create', definition: parseDefinition(DEFINITION), secrets: {} });
  const { id } = created;
  const fingerprint = destinationFingerprint(store.get(id));
  const grant = (accessToken, refreshToken) => ({ accessToken, refreshToken, expiresAt: clock - 1, scope: null });
  await store.updateOAuth(id, fingerprint, () => ({
    issuer: 'https://as.example.com/',
    authorizationEndpoint: 'https://as.example.com/authorize',
    tokenEndpoint: 'https://as.example.com/token',
    revocationEndpoint: null,
    registrationEndpoint: null,
    client: { clientId: 'client', clientSecret: null, redirectUri: 'https://app.example/api/protected-mcp/oauth/callback' },
    tokens: grant('at-1', 'rt-1'),
  }));
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    arrived();
    await gate;
    return answer();
  };
  const oauth = createOAuth({ store, fetchImpl, now: () => clock });
  // What a new authorization stores: a new grant, here with whatever refresh token the server chose.
  const authorizeAgain = (accessToken, refreshToken) => store.updateOAuth(id, fingerprint, (previous) => ({ ...previous, tokens: grant(accessToken, refreshToken) }));
  return { store, id, oauth, reached, release, authorizeAgain };
}

const storedTokens = (store, id) => store.credentialsFor(store.get(id))?.oauth?.tokens ?? null;

describe('OAuth writes that race administrative changes', () => {
  it.each([false, '2', null, undefined, 2])('completes sign-in with opaque generation %j', async (generation) => {
    // Given partial OAuth state and a local authorization server.
    const { store } = await setup();
    const server = await startHttpFixture({ oauth: true });
    cleanups.push(server.close);
    const { connection } = await store.apply({ kind: 'create', definition: parseDefinition({
      name: 'generation', transport: 'http', http: { url: server.url, oauth: { scopes: [] } },
    }), secrets: {} });
    const definition = store.get(connection.id);
    await store.updateOAuth(definition.id, destinationFingerprint(definition), () => ({ generation }));
    const oauth = createOAuth({ store });
    // When sign-in traverses discovery, local consent and the code exchange.
    const flow = await oauth.start({ id: definition.id, expectedRevision: definition.revision, redirectUri: 'https://app.example/callback' });
    const consent = await fetch(flow.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const callback = new URL(consent.headers.get('location'));
    const answer = await oauth.complete(Object.fromEntries(callback.searchParams));
    // Then the existing opaque value cannot prevent authorization.
    expect(answer.outcome).toBe('authorized');
  });

  it('returns the original fresh stored grant when authorization metadata is absent', async () => {
    // Given a stored grant that needs no refresh and has no server or client metadata.
    const { store, id, oauth } = await setup();
    const definition = store.get(id);
    const tokens = { accessToken: 'synthetic-existing', expiresAt: null };
    await store.updateOAuth(id, destinationFingerprint(definition), () => ({ tokens }));
    // When the caller requests its usable tokens.
    const answer = await oauth.tokensFor(definition);
    // Then the stored object remains the grant's identity.
    expect(answer).toBe(tokens);
  });

  it('refreshes a stored grant when its expiry is omitted', async () => {
    // Given refreshable tokens with no expiry field, distinct from explicit null.
    const { store, id, oauth, reached, release } = await setup();
    const definition = store.get(id);
    await store.updateOAuth(id, destinationFingerprint(definition), (previous) => ({
      ...previous, tokens: { accessToken: 'at-1', refreshToken: 'rt-1' },
    }));
    // When tokens are requested and the refresh answer arrives.
    const refreshing = oauth.tokensFor(definition);
    await reached;
    release();
    // Then the caller receives the refreshed grant.
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('does not bring tokens back when a refresh finishes after the administrator revoked them', async () => {
    const { store, id, oauth, reached, release } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await store.apply({ kind: 'revoke-credentials', id, expectedRevision: store.get(id).revision });
    release();
    await expect(refreshing).rejects.toMatchObject({ code: 'authorization_required' });
    expect(store.credentialState(store.get(id))).toBe('authorization_required');
    expect(store.credentialsFor(store.get(id))).toBeNull();
  });

  it('keeps a grant authorized while a refresh of the old one was on the wire, and answers with it', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-new');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
  });

  it('keeps a new grant that received the same refresh token, over a late refresh of the old one', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-1');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-1' });
  });

  it('keeps a new grant that received the same refresh token, when the old one\'s refresh is refused late', async () => {
    const { store, id, oauth, reached, release, authorizeAgain } = await setup({ answer: refused });
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    await authorizeAgain('at-new', 'rt-1');
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-new' });
    expect(store.credentialState(store.get(id))).toBe('authorized');
  });

  it('stores a refresh that finishes after a policy-only change', async () => {
    const { store, id, oauth, reached, release } = await setup();
    const refreshing = oauth.tokensFor(store.get(id));
    await reached;
    const policy = parseDefinition({ ...DEFINITION, policy: { denyTools: ['delete_everything'] } });
    await store.apply({ kind: 'update', id, expectedRevision: store.get(id).revision, definition: policy, secrets: {} });
    release();
    await expect(refreshing).resolves.toMatchObject({ accessToken: 'at-2' });
    expect(storedTokens(store, id)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('forgets only the grant an upstream refused, told apart by identity', async () => {
    const { store, id, oauth } = await setup();
    const used = storedTokens(store, id);
    // Same strings, another grant: an equal copy is not the stored grant.
    await oauth.markUnauthorized(store.get(id), { tokens: { ...used } });
    expect(store.credentialState(store.get(id))).toBe('authorized');
    await oauth.markUnauthorized(store.get(id), { tokens: used });
    expect(store.credentialState(store.get(id))).toBe('authorization_required');
  });
});
