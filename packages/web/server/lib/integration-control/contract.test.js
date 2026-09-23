import { describe, expect, it } from 'vitest';
import { readFileSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ACTIONS, ERROR_DEFINITIONS, MAX_BODY_BYTES, MAX_PROMPT_LENGTH,
  parseRequest, parseResponse, serializeRequest, serializeResponse,
} from './contract.js';

const fixtureRoot = new URL('./fixtures/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('protocol.json', fixtureRoot), 'utf8'));
const failure = {
  success: false,
  error: { code: 'INVALID_REQUEST', message: 'Invalid integration request.' },
};
const request = (action, input) => ({ schemaVersion: 1, requestId: corpus.valid[0].request.requestId, action, input });
const parseInput = (action, input) => parseRequest(JSON.stringify(request(action, input)));

describe('integration wire v1', () => {
  it.each(corpus.valid)('roundtrips $request.action requests and responses', ({ request: req, response }) => {
    for (const [value, parse, serialize] of [[req, parseRequest, serializeRequest], [response, parseResponse, serializeResponse]]) {
      const parsed = parse(JSON.stringify(value));
      expect(parsed.success).toBe(true);
      const encoded = serialize(parsed.data);
      expect(encoded.success).toBe(true);
      expect(parse(encoded.data)).toEqual(parsed);
    }
  });

  it('covers exactly seven actions and rejects invalid fixtures', () => {
    expect(corpus.valid.map(({ request: req }) => req.action)).toEqual(ACTIONS);
    for (const { request: req } of corpus.invalid) expect(parseRequest(JSON.stringify(req))).toEqual(failure);
    const errors = JSON.parse(readFileSync(new URL('errors.json', fixtureRoot), 'utf8'));
    for (const response of errors.valid) expect(parseResponse(serializeResponse(response).data).data).toEqual(response);
    for (const response of errors.invalid) expect(parseResponse(JSON.stringify(response))).toEqual(failure);
  });

  it('applies only the documented defaults', () => {
    expect(parseInput('session.list', { projectId: 'project_demo' }).data.input).toEqual({ projectId: 'project_demo', limit: 10, all: false });
    expect(parseInput('session.messages', { projectId: 'project_demo', sessionId: 'ses_demo', lastAssistant: true }).data.input)
      .toEqual({ projectId: 'project_demo', sessionId: 'ses_demo', limit: 10, lastAssistant: true });
  });

  it('rejects unknown keys at every request level for every action', () => {
    const forbidden = ['directory', 'contextDirectory', 'url', 'URL', 'headers', 'token', 'goal', 'wait', 'cancel', 'permission', 'branch', 'startRef'];
    for (const { request: req } of corpus.valid) {
      for (const key of forbidden) {
        expect(parseRequest(JSON.stringify({ ...req, [key]: 'synthetic' }))).toEqual(failure);
        expect(parseRequest(JSON.stringify({ ...req, input: { ...req.input, [key]: 'synthetic' } }))).toEqual(failure);
      }
      expect(parseRequest(JSON.stringify({ ...req, schemaVersion: 2 }))).toEqual(failure);
      expect(parseRequest(JSON.stringify({ ...req, requestId: 'not-a-uuid' }))).toEqual(failure);
      expect(parseRequest(JSON.stringify({ ...req, input: [] }))).toEqual(failure);
    }
  });

  it('enforces required fields, types and integer ranges without coercion', () => {
    for (const action of ACTIONS.filter((value) => value !== 'projects.list')) expect(parseInput(action, {})).toEqual(failure);
    for (const limit of [0, 101, 1.5, '10', null]) {
      for (const action of ['session.list', 'session.messages']) {
        const input = { projectId: 'project_demo', limit, ...(action === 'session.messages' ? { sessionId: 'ses_demo' } : {}) };
        expect(parseInput(action, input)).toEqual(failure);
      }
    }
    expect(parseInput('session.list', { projectId: 'project_demo', all: 'false' })).toEqual(failure);
    expect(parseInput('session.fork', { projectId: 'project_demo', sessionId: 'ses_demo' })).toEqual(failure);
    expect(parseInput('session.create', { projectId: 'project_demo', model: {} })).toEqual(failure);
  });

  it('accepts only a simple worktree name, never a path or options object', () => {
    for (const worktree of ['/tmp/demo', '../demo', 'a/b', 'a\\b', '.', '..', { name: 'demo' }]) {
      expect(parseInput('session.create', { projectId: 'project_demo', worktree })).toEqual(failure);
    }
  });

  it('checks prompt and body boundaries including UTF-8 and whitespace', () => {
    const input = { projectId: 'project_demo', sessionId: 'ses_demo', prompt: 'x'.repeat(MAX_PROMPT_LENGTH) };
    expect(parseInput('session.send', input).success).toBe(true);
    expect(parseInput('session.send', { ...input, prompt: `${input.prompt}x` })).toEqual(failure);
    expect(parseInput('session.send', { ...input, prompt: ' ' })).toEqual(failure);
    const raw = JSON.stringify(corpus.valid[0].request);
    expect(parseRequest(raw.padEnd(MAX_BODY_BYTES)).success).toBe(true);
    expect(parseRequest(raw.padEnd(MAX_BODY_BYTES + 1))).toEqual(failure);
    expect(parseRequest(`"${'é'.repeat(MAX_BODY_BYTES / 2)}"`)).toEqual(failure);
    for (const raw of ['', '{', 'null', '[]', '{}', undefined]) expect(parseRequest(raw)).toEqual(failure);
  });

  it('caps response messages and serialized body size', () => {
    const response = structuredClone(corpus.valid.at(-1).response);
    const msg = { id: 'msg_demo', role: 'assistant', text: 'Synthetic.' };
    response.data.messages = Array.from({ length: 100 }, () => msg);
    expect(serializeResponse(response).success).toBe(true);
    response.data.messages.push(msg);
    expect(serializeResponse(response)).toEqual(failure);
    expect(parseResponse(JSON.stringify(response))).toEqual(failure);
    response.data.messages = [{ ...msg, text: 'é'.repeat(MAX_BODY_BYTES / 2) }];
    expect(serializeResponse(response)).toEqual(failure);
    expect(parseResponse(JSON.stringify(response))).toEqual(failure);
  });

  it('rejects response extras and inconsistent success/error envelopes', () => {
    for (const { response } of corpus.valid) {
      expect(parseResponse(JSON.stringify({ ...response, directory: '/synthetic' }))).toEqual(failure);
      expect(serializeResponse({ ...response, data: { ...response.data, token: 'synthetic' } })).toEqual(failure);
      expect(serializeResponse({ ...response, ok: false })).toEqual(failure);
      expect(serializeResponse({ ...response, data: undefined })).toEqual(failure);
    }
  });

  it('fixes sanitized errors and requires partial/sessionId together', () => {
    for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
      const response = { ...corpus.valid[0].response, ok: false, data: undefined, error: { code, message: definition.message } };
      expect(parseResponse(serializeResponse(response).data).success).toBe(true);
      expect(serializeResponse({ ...response, error: { ...response.error, message: 'upstream details' } })).toEqual(failure);
      expect(serializeResponse({ ...response, error: { ...response.error, partial: true } })).toEqual(failure);
      expect(serializeResponse({ ...response, error: { ...response.error, sessionId: 'ses_demo' } })).toEqual(failure);
      expect(serializeResponse({ ...response, error: { ...response.error, partial: true, sessionId: 'ses_demo' } }).success).toBe(true);
    }
    expect(Object.values(ERROR_DEFINITIONS).map(({ statusCode }) => statusCode)).toEqual([401, 403, 403, 404, 400, 503]);
  });

  it('does not mutate caller objects', () => {
    const req = request('session.list', { projectId: 'project_demo' });
    const before = structuredClone(req);
    expect(serializeRequest(req).success).toBe(true);
    expect(req).toEqual(before);
  });

  it('pins fixture bytes and the independent HP copy', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'));
    const hpRoot = new URL('../../../../../../hermes-openchamber/tests/fixtures/protocol/', import.meta.url);
    expect(manifest.fixtureSetVersion).toBe('1.0.0');
    expect(manifest.schemaVersion).toBe(1);
    expect(readdirSync(fixtureRoot).sort()).toEqual(['manifest.json', ...Object.keys(manifest.files)].sort());
    for (const [name, hash] of Object.entries(manifest.files)) {
      const bytes = readFileSync(new URL(name, fixtureRoot));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    }
    for (const name of readdirSync(fixtureRoot)) {
      expect(lstatSync(new URL(name, hpRoot)).isSymbolicLink()).toBe(false);
      expect(readFileSync(new URL(name, hpRoot))).toEqual(readFileSync(new URL(name, fixtureRoot)));
    }
  });
});
