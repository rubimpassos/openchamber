import type { Request, Response, Router } from '../shared/http-contracts.js';
import type { createFixLoopRuntime } from './runtime.js';
import { errorField } from './errors.js';

const sendFixLoopError = (res: Response, error: unknown) => {
  const response = errorField(error, 'sourceControlResponse');
  return res.status(errorField(response, 'status') ?? errorField(error, 'statusCode') ?? errorField(error, 'status') ?? 500)
    .json(errorField(response, 'body') ?? { error: errorField(error, 'message') ?? 'Fix loop request failed' });
};

/** How a failed POST answers, here and where the front door creates one itself. */
export function sendFixLoopCreateError(res: Response, error: unknown) {
  const code = errorField(error, 'code');
  if (errorField(error, 'response') !== undefined || code) return res.status(errorField(error, 'status') ?? errorField(error, 'statusCode') ?? 400)
    .json({ error: errorField(error, 'message'), code });
  return sendFixLoopError(res, error);
}

type RouteRuntime = Pick<ReturnType<typeof createFixLoopRuntime>, 'list' | 'listPreparedWorkers' | 'forgetPreparedWorker'
  | 'update' | 'stopLoop' | 'refresh' | 'resume' | 'approve' | 'remove'>;
type RouteOptions<Body> = { readonly runtime: RouteRuntime;
  readonly createWithContext: (req: Request<Body>, options?: { readonly prepareWorker: boolean }) => Promise<unknown> };

export function registerFixLoopRoutes<Body>(app: Router, { runtime, createWithContext }: RouteOptions<Body>) {
  const send = sendFixLoopError;
  const base = '/api/source-control/github/pr/fix-loops';
  app.get(base, async (_req, res) => {
    try { res.json({ loops: await runtime.list() }); } catch (error) { send(res, error); }
  });
  app.post<Body>(base, async (req, res) => {
    try { res.json({ loop: await createWithContext(req) }); } catch (error) { sendFixLoopCreateError(res, error); }
  });
  app.post<Body>(`${base}/workers`, async (req, res) => {
    try { res.status(202).json({ worker: await createWithContext(req, { prepareWorker: true }) }); } catch (error) { send(res, error); }
  });
  app.get(`${base}/workers`, async (_req, res) => {
    try { res.json({ workers: await runtime.listPreparedWorkers() }); } catch (error) { send(res, error); }
  });
  app.delete<unknown, { id: string }>(`${base}/workers/:id`, async (req, res) => {
    try { res.json(await runtime.forgetPreparedWorker(req.params.id)); } catch (error) { send(res, error); }
  });
  app.patch<unknown, { id: string }>(`${base}/:id`, async (req, res) => {
    try { res.json({ loop: await runtime.update(req.params.id, errorField(req.body, 'config')) }); } catch (error) { send(res, error); }
  });
  app.post<unknown, { id: string }>(`${base}/:id/stop`, async (req, res) => {
    try { res.json({ loop: await runtime.stopLoop(req.params.id) }); } catch (error) { send(res, error); }
  });
  app.post<unknown, { id: string }>(`${base}/:id/refresh`, async (req, res) => {
    try { res.json({ loop: await runtime.refresh(req.params.id) }); } catch (error) { send(res, error); }
  });
  app.post<unknown, { id: string }>(`${base}/:id/resume`, async (req, res) => {
    try { res.json({ loop: await runtime.resume(req.params.id) }); } catch (error) { send(res, error); }
  });
  app.post<unknown, { id: string }>(`${base}/:id/approve`, async (req, res) => {
    try { res.json({ loop: await runtime.approve(req.params.id, errorField(req.body, 'receiptId')) }); } catch (error) { send(res, error); }
  });
  app.delete<unknown, { id: string }>(`${base}/:id`, async (req, res) => {
    try { res.json(await runtime.remove(req.params.id)); } catch (error) { send(res, error); }
  });
}
