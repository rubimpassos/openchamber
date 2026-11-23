import type { Request } from './http-contracts.js';
import { isString } from './guards.js';

export const requestOrigin = (req: Pick<Request, 'headers' | 'secure'>) => {
  const forwarded = req.headers['x-forwarded-proto'];
  const forwardedProtocol = isString(forwarded) ? forwarded.split(',', 1)[0] : undefined;
  const proto = forwardedProtocol ? forwardedProtocol.trim() : req.secure ? 'https' : 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const host = isString(hostHeader) ? hostHeader.split(',', 1)[0]?.trim() : undefined;
  if (!host) {
    return null;
  }
  return `${proto}://${host}`;
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const renderOauthCallbackPage = ({ title, message }: { readonly title: string; readonly message: string }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenChamber</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.5; opacity: 0.85; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
