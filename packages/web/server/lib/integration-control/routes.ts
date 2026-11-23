import express from 'express';
import { checkIntegrationToken } from './auth.js';
import { ERROR_DEFINITIONS, MAX_BODY_BYTES, parseRequest, serializeResponse } from './contract.js';
import { createIntegrationScope, IntegrationScopeError } from './scope.js';
import { isRecord } from '../shared/guards.js';
import type { IncomingMessage, Server } from 'node:http';
import type { Application, Response } from '../shared/http-contracts.js';
import type { IntegrationErrorCode, IntegrationRequest } from './contract.js';
import type { IntegrationCredential } from './policy.js';
import type { IntegrationScopeDependencies, SessionRow } from './scope.js';
import type { createOpenChamberControlService } from '../openchamber-control/service.js';

type IntegrationDependencies = Omit<IntegrationScopeDependencies, 'controlService'> & {
  readonly controlService: Pick<ReturnType<typeof createOpenChamberControlService>, 'execute' | 'resolveSessionDirectory'>;
  readonly server?: Pick<Server, 'prependListener'>;
};
type PublicError = { readonly code: IntegrationErrorCode; readonly message: string; partial?: true; sessionId?: unknown };
type Audit = { requestId: string | null; domainId: string | null; action: string | null };

const endpoint = '/api/openchamber/integration/control';
const bearerToken = (req: IncomingMessage) => /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
const publicError = (code: IntegrationErrorCode): PublicError => ({ code, message: ERROR_DEFINITIONS[code].message });
const reject = (res: Response, code: IntegrationErrorCode, status: number = ERROR_DEFINITIONS[code].statusCode) =>
  res.status(status).json({ error: publicError(code) });

// Namespace rejection is independent of policy validity and ambient UI cookies.
const parseRequestUrl = (req: IncomingMessage) => {
  try {
    return new URL(req.url ?? '', 'http://localhost');
  } catch {
    return null;
  }
};

const hasIntegrationCredential = (req: IncomingMessage, url: URL) => {
  if (/\boc_integration_/i.test(req.headers.authorization || '')) return true;
  const query = url.searchParams;
  return ['oc_url_token', 'token'].some((key) => query.getAll(key).some((value) => value.startsWith('oc_integration_')));
};

type Projection = {
  readonly scope: ReturnType<typeof createIntegrationScope>;
  readonly credential: IntegrationCredential;
  readonly request: IntegrationRequest;
  readonly result: unknown;
  readonly projects: Awaited<ReturnType<ReturnType<typeof createIntegrationScope>['filterProjects']>> | undefined;
};
const isSessionRow = (value: unknown): value is SessionRow => isRecord(value);
const projectResult = async ({ scope, credential, request, result, projects }: Projection) => {
  if (!isRecord(result)) throw new Error('Invalid control response');
  switch (request.action) {
    case 'projects.list':
      return { projects };
    case 'session.list':
      if (!Array.isArray(result.sessions) || !result.sessions.every(isSessionRow)) throw new Error('Invalid control response');
      return { sessions: await scope.filterSessions(credential, request.input, result.sessions) };
    case 'session.create':
    case 'session.send':
      return { sessionId: result.sessionId, promptDispatched: result.promptDispatched };
    case 'session.fork':
      return { sessionId: result.sessionId, promptDispatched: result.promptDispatched, sourceSessionId: request.input.sessionId };
    case 'session.status':
      if (!isRecord(result.sessionStatus)) throw new Error('Invalid control response');
      return { sessionId: request.input.sessionId, sessionStatus: { type: result.sessionStatus.type } };
    case 'session.messages':
      if (!isRecord(result.sessionStatus) || !Array.isArray(result.messages)) throw new Error('Invalid control response');
      return {
        sessionId: request.input.sessionId,
        sessionStatus: { type: result.sessionStatus.type },
        messages: result.messages.map((message: unknown) => {
          if (!isRecord(message)) throw new Error('Invalid control response');
          return { id: message.id, role: message.role, text: message.text };
        }),
      };
  }
};

export const registerIntegrationControlRoutes = (app: Application, dependencies: IntegrationDependencies) => {
  const { controlService, server } = dependencies;
  const scope = createIntegrationScope(dependencies);
  // Raw bytes are bounded by body-parser before contract.js performs JSON.parse.
  const readBody = express.raw({ type: 'application/json', limit: MAX_BODY_BYTES, inflate: false });
  const audits = new WeakMap<Response, Audit>();

  app.use('/api/openchamber/integration', (_req, res, next) => {
    const started = performance.now();
    const audit: Audit = { requestId: null, domainId: null, action: null };
    audits.set(res, audit);
    const complete = () => {
      res.off('finish', complete);
      res.off('close', complete);
      const statusCode = res.writableFinished ? res.statusCode : 499;
      console.log(JSON.stringify({
        event: 'integration_control_request', ...audit,
        ok: res.writableFinished && statusCode >= 200 && statusCode < 300,
        statusCode, durationMs: Math.max(0, performance.now() - started),
      }));
    };
    res.once('finish', complete);
    res.once('close', complete);
    next();
  });

  app.post(endpoint, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    readBody(req, res, (error) => error
      ? reject(res, 'INVALID_REQUEST', typeof error === 'object' && error !== null
        && 'type' in error && error.type === 'entity.too.large' ? 413 : 400)
      : next());
  }, async (req, res) => {
    const parsed = parseRequest(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : undefined);
    if (!parsed.success) return reject(res, 'INVALID_REQUEST');
    const request = parsed.data;
    const audit = audits.get(res);
    if (audit) {
      audit.requestId = request.requestId;
      audit.action = request.action;
    }
    const auth = await checkIntegrationToken(bearerToken(req));
    if (!auth.success) return reject(res, auth.error.code);
    const credential = auth.data;
    if (audit) audit.domainId = credential.domain;
    const envelope = {
      schemaVersion: request.schemaVersion, requestId: request.requestId,
      domainId: credential.domain, action: request.action,
    };
    const send = (value: object, status = 200) => {
      const serialized = serializeResponse({ ...envelope, ...value });
      if (!serialized.success) return false;
      res.status(status).type('application/json').send(serialized.data);
      return true;
    };
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    if (req.aborted || res.destroyed) controller.abort();
    let result: unknown;
    let authorized = false;
    try {
      const scoped = await scope.authorize(credential, request.action, request.input);
      const projects = request.action === 'projects.list' ? await scope.filterProjects(credential) : undefined;
      authorized = true;
      controller.signal.throwIfAborted();
      const controlInput = request.action === 'session.list'
        ? { ...scoped.controlInput, limit: Number.MAX_SAFE_INTEGER }
        : scoped.controlInput;
      result = await controlService.execute(request.action, controlInput, undefined, { signal: controller.signal });
      const data = await projectResult({ scope, credential, request, result, projects });
      if (send({ ok: true, data })) return;
      throw new Error('Invalid control response');
    } catch (error) {
      const code = error instanceof IntegrationScopeError ? error.code : 'INVALID_REQUEST';
      const status = error instanceof IntegrationScopeError ? error.statusCode : 500;
      const failureFields = isRecord(error) ? error : undefined;
      const resultFields = isRecord(result) ? result : undefined;
      const partial = authorized && (failureFields?.partial === true
        || (result && ['session.create', 'session.send', 'session.fork'].includes(request.action)));
      const failure = publicError(code);
      if (partial) {
        failure.partial = true;
        failure.sessionId = failureFields?.sessionId || resultFields?.sessionId;
      }
      // The contract also validates partial IDs; never echo upstream messages.
      if (!send({ ok: false, error: failure }, status)) {
        send({ ok: false, error: publicError('INVALID_REQUEST') }, 500);
      }
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  });

  // Consume unsupported integration paths/methods, never common auth or proxy.
  app.use('/api/openchamber/integration', (_req, res) => reject(res, 'UNAUTHORIZED'));
  app.use((req, res, next) => {
    const url = parseRequestUrl(req);
    return !url || hasIntegrationCredential(req, url) ? reject(res, 'UNAUTHORIZED') : next();
  });

  // HTTP upgrades do not traverse Express. Close before any WS handler can
  // establish a connection, including when password-less UI access is enabled.
  server?.prependListener('upgrade', (req, socket) => {
    const url = parseRequestUrl(req);
    if (url && !hasIntegrationCredential(req, url) && !url.pathname.startsWith('/api/openchamber/integration')) return;
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
};
