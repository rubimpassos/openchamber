import express from 'express';
import { checkIntegrationToken } from './auth.js';
import { ERROR_DEFINITIONS, MAX_BODY_BYTES, parseRequest, serializeResponse } from './contract.js';
import { createIntegrationScope, IntegrationScopeError } from './scope.js';

const endpoint = '/api/openchamber/integration/control';
const bearerToken = (req) => /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1];
const publicError = (code) => ({ code, message: ERROR_DEFINITIONS[code].message });
const reject = (res, code, status = ERROR_DEFINITIONS[code].statusCode) =>
  res.status(status).json({ error: publicError(code) });

// Namespace rejection is independent of policy validity and ambient UI cookies.
const hasIntegrationCredential = (req) => {
  if (/\boc_integration_/i.test(req.headers.authorization || '')) return true;
  const query = new URL(req.url, 'http://localhost').searchParams;
  return ['oc_url_token', 'token'].some((key) => query.getAll(key).some((value) => value.startsWith('oc_integration_')));
};

const projectResult = async (scope, credential, request, result, projects) => {
  switch (request.action) {
    case 'projects.list':
      return { projects };
    case 'session.list':
      return { sessions: await scope.filterSessions(credential, request.input, result.sessions) };
    case 'session.create':
    case 'session.send':
      return { sessionId: result.sessionId, promptDispatched: result.promptDispatched };
    case 'session.fork':
      return { sessionId: result.sessionId, promptDispatched: result.promptDispatched, sourceSessionId: request.input.sessionId };
    case 'session.status':
      return { sessionId: request.input.sessionId, sessionStatus: { type: result.sessionStatus.type } };
    case 'session.messages':
      return {
        sessionId: request.input.sessionId,
        sessionStatus: { type: result.sessionStatus.type },
        messages: result.messages.map(({ id, role, text }) => ({ id, role, text })),
      };
  }
};

export const registerIntegrationControlRoutes = (app, dependencies) => {
  const { controlService, server } = dependencies;
  const scope = createIntegrationScope(dependencies);
  // Raw bytes are bounded by body-parser before contract.js performs JSON.parse.
  const readBody = express.raw({ type: 'application/json', limit: MAX_BODY_BYTES, inflate: false });

  app.use('/api/openchamber/integration', (_req, res, next) => {
    const started = performance.now();
    const audit = { requestId: null, domainId: null, action: null };
    res.locals.integrationAudit = audit;
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
      ? reject(res, 'INVALID_REQUEST', error.type === 'entity.too.large' ? 413 : 400)
      : next());
  }, async (req, res) => {
    const parsed = parseRequest(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : undefined);
    if (!parsed.success) return reject(res, 'INVALID_REQUEST');
    const request = parsed.data;
    res.locals.integrationAudit.requestId = request.requestId;
    res.locals.integrationAudit.action = request.action;
    const auth = await checkIntegrationToken(bearerToken(req));
    if (!auth.success) return reject(res, auth.error.code);
    const credential = auth.data;
    res.locals.integrationAudit.domainId = credential.domain;
    const envelope = {
      schemaVersion: request.schemaVersion, requestId: request.requestId,
      domainId: credential.domain, action: request.action,
    };
    const send = (value, status = 200) => {
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
    let result;
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
      const data = await projectResult(scope, credential, request, result, projects);
      if (send({ ok: true, data })) return;
      throw new Error('Invalid control response');
    } catch (error) {
      const code = error instanceof IntegrationScopeError ? error.code : 'INVALID_REQUEST';
      const status = error instanceof IntegrationScopeError ? error.statusCode : 500;
      const partial = authorized && (error?.partial === true
        || (result && ['session.create', 'session.send', 'session.fork'].includes(request.action)));
      const failure = publicError(code);
      if (partial) {
        failure.partial = true;
        failure.sessionId = error?.sessionId || result?.sessionId;
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
  app.use((req, res, next) => hasIntegrationCredential(req) ? reject(res, 'UNAUTHORIZED') : next());

  // HTTP upgrades do not traverse Express. Close before any WS handler can
  // establish a connection, including when password-less UI access is enabled.
  server?.prependListener('upgrade', (req, socket) => {
    if (!hasIntegrationCredential(req) && !new URL(req.url, 'http://localhost').pathname.startsWith('/api/openchamber/integration')) return;
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
};
