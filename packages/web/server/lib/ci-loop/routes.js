import express from 'express';

const DEFAULT_CI_LOOP_PORT = 4517;
const CI_LOOP_TIMEOUT_MS = 3_000;

function resolveCiLoopPort() {
  const raw = Number.parseInt(process.env.OPENCHAMBER_CI_LOOP_PORT || '', 10);
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : DEFAULT_CI_LOOP_PORT;
}

function ciLoopUrl(pathname) {
  return `http://127.0.0.1:${resolveCiLoopPort()}${pathname}`;
}

async function fetchCiLoop(pathname, init) {
  return fetch(ciLoopUrl(pathname), {
    ...init,
    signal: AbortSignal.timeout(CI_LOOP_TIMEOUT_MS),
  });
}

function isValidSessionId(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('/');
}

// Proxy to the opencode-ci-loop plugin dashboard server (loopback-only by
// design). The plugin lives inside the OpenCode process; when it is not
// installed or not running, GET reports `available: false` instead of failing
// so the UI can hide the CI monitor affordance entirely.
export function registerCiLoopRoutes(app) {
  app.get('/api/ci-loop/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    if (!isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    try {
      const upstream = await fetchCiLoop(`/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!upstream.ok) {
        res.json({ available: false });
        return;
      }
      const session = await upstream.json();
      res.json({ available: true, session });
    } catch {
      res.json({ available: false });
    }
  });

  app.post('/api/ci-loop/session/:sessionId/enabled', express.json({ limit: '16kb' }), async (req, res) => {
    const sessionId = req.params.sessionId;
    const enabled = req.body?.enabled;
    if (!isValidSessionId(sessionId) || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'sessionId and boolean enabled are required' });
      return;
    }
    try {
      const upstream = await fetchCiLoop(`/sessions/${encodeURIComponent(sessionId)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!upstream.ok) {
        res.status(502).json({ error: `CI loop plugin rejected the toggle (${upstream.status})` });
        return;
      }
      const session = await upstream.json();
      res.json({ available: true, session });
    } catch {
      res.status(502).json({ error: 'CI loop plugin is not reachable' });
    }
  });
}
