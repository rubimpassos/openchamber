import express from 'express';
import { mintOutsideFileGrant } from '../fs/routes.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { fitRenderPageImages, renderPageImageSources } from '../openchamber-control/render-page.js';
import { generatedImagePaths } from '../openchamber-control/generate-image.js';
import { capturedScreenshotPaths } from '../openchamber-control/screenshots.js';
import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import { inspectLocalImage } from './inspect-image.js';
import type { PageImageInspection } from '../openchamber-control/render-page.js';
import type { DirectoryValidation } from '../projects/contracts.js';
import type { Application } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { LocalImageInspection, LocalImageInspectionOptions } from './inspect-image.js';
import { markdownImageSources } from './discovery.js';

type OutsideFileGrantOptions = NonNullable<Parameters<typeof mintOutsideFileGrant>[1]>;

export interface MarkdownImageGrantDependencies {
  fsPromises: LocalImageInspectionOptions['fsPromises'] & NonNullable<OutsideFileGrantOptions['fsPromises']>;
  path: NonNullable<OutsideFileGrantOptions['path']>;
  crypto: NonNullable<OutsideFileGrantOptions['crypto']>;
  validateDirectoryPath: (directory: string) => Promise<DirectoryValidation>;
  buildOpenCodeUrl: (route: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}

type MessageLookup = Pick<MarkdownImageGrantDependencies, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> & {
  sessionId: string;
  messageId: string;
  directory: string;
};

const isJsonRecord = (value: JsonValue | undefined): value is JsonObject => isRecord(value);
const hasErrorMessage = (value: unknown): value is { message?: unknown } => value != null;

const messageContent = (message: JsonObject): JsonValue[] => {
  if (Array.isArray(message.content)) return message.content;
  if (isString(message.text)) return [{ type: 'text', text: message.text }];
  return [];
};

const spilledPageHtml = (input: JsonObject | undefined) => {
  if (!isString(input?.action) || !input.action.trim().startsWith('{')) return undefined;
  let revived: JsonValue;
  try {
    revived = JSON.parse(input.action);
  } catch {
    return undefined;
  }
  if (!isJsonRecord(revived)) return undefined;
  return isJsonRecord(revived.parameters) && Object.hasOwn(revived.parameters, 'html')
    ? revived.parameters.html
    : revived.html;
};

const renderPages = (message: JsonObject) => {
  const pages = new Map<JsonValue | undefined, string>();
  for (const part of messageContent(message)) {
    if (!isJsonRecord(part) || part.type !== 'tool' || part.name !== 'openchamber_render') continue;
    const state = isJsonRecord(part.state) ? part.state : undefined;
    const input = isJsonRecord(state?.input) ? state.input : undefined;
    const parameters = isJsonRecord(input?.parameters) ? input.parameters : undefined;
    const html = [parameters?.html, input?.html, spilledPageHtml(input)].find(isString);
    if (html !== undefined) pages.set(part.id, html);
  }
  return pages;
};

const renderPageSources = (message: JsonObject) => {
  const sources = new Set<string>();
  for (const html of renderPages(message).values()) {
    for (const source of renderPageImageSources(html)) sources.add(source);
  }
  return sources;
};

const decodeComparablePath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const comparablePath = (value: string) => {
  let text = value;
  if (/^file:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      return '';
    }
  }
  text = decodeComparablePath(text).replace(/\\/g, '/');
  return /^\/[A-Za-z]:\//.test(text) ? text.slice(1) : text;
};

const TOOL_RESULT_IMAGE_PATHS = new Map([
  ['openchamber_image', generatedImagePaths],
  ['openchamber_web', capturedScreenshotPaths],
  ['execute', capturedScreenshotPaths],
]);

const toolResultImageSources = (message: JsonObject) => {
  const sources = new Set<string>();
  for (const part of messageContent(message)) {
    if (!isJsonRecord(part)) continue;
    const readPaths = part.type === 'tool' && isString(part.name) ? TOOL_RESULT_IMAGE_PATHS.get(part.name) : undefined;
    if (!readPaths || !isJsonRecord(part.state) || part.state.status !== 'completed') continue;
    for (const item of Array.isArray(part.state.content) ? part.state.content : []) {
      if (!isJsonRecord(item) || item.type !== 'text' || !isString(item.text)) continue;
      for (const source of readPaths(item.text)) sources.add(comparablePath(source));
    }
  }
  return sources;
};

const fetchMessage = async ({ sessionId, messageId, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders }: MessageLookup) => {
  const url = new URL(buildOpenCodeUrl(
    `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    '',
  ));
  url.searchParams.set('directory', directory);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-opencode-directory': encodeURIComponent(directory),
      ...getOpenCodeAuthHeaders(),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenCode returned ${response.status}`);
  const body: JsonValue = await response.json().catch(() => null);
  const message = unwrapOpenCodeResponse(body);
  return isJsonRecord(message) && isString(message.id) ? message : null;
};

export const registerMarkdownImageGrantRoutes = (app: Application, dependencies: MarkdownImageGrantDependencies) => {
  const {
    fsPromises,
    path,
    crypto,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = dependencies;

  app.post(
    '/api/openchamber/sessions/:sessionId/markdown-image-grants',
    express.json({ limit: '256kb' }),
    async (req, res) => {
      const body = isRecord(req.body) ? req.body : undefined;
      const sessionId = asNonEmptyString(req.params.sessionId);
      const messageId = asNonEmptyString(body?.messageId);
      const sources = Array.isArray(body?.sources)
        ? [...new Set(body.sources.map(asNonEmptyString).filter((source) => source !== null))]
        : [];
      const callId = asNonEmptyString(body?.callId);
      if (!sessionId || !messageId || sources.length === 0) {
        return res.status(400).json({ error: 'sessionId, messageId, and sources are required' });
      }
      const validatedDirectory = await validateDirectoryPath(asNonEmptyString(body?.directory) ?? '');
      if (!validatedDirectory.ok) {
        return res.status(400).json({ error: validatedDirectory.error || 'Invalid directory' });
      }

      try {
        const message = await fetchMessage({
          sessionId,
          messageId,
          directory: validatedDirectory.directory,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
        });
        if (!message || message.id !== messageId || message.type !== 'assistant') {
          return res.status(404).json({ error: 'Assistant message not found' });
        }
        const inspect = (source: string) => inspectLocalImage({
          source,
          directory: validatedDirectory.directory,
          fsPromises,
          path,
        }).catch((): LocalImageInspection => ({ status: 'error' }));
        let check: (source: string) => LocalImageInspection | PageImageInspection | Promise<LocalImageInspection>;
        if (callId) {
          const html = renderPages(message).get(callId);
          if (html === undefined) return res.status(404).json({ error: 'Page not found' });
          const { images } = await fitRenderPageImages(html, inspect);
          const checked = new Map(images.map((image) => [image.source, image]));
          check = (source) => checked.get(source) ?? { status: 'error' };
        } else {
    const markdown = messageContent(message).flatMap((part) =>
      isJsonRecord(part) && part.type === 'text' && isString(part.text) ? [part.text] : []);
    const referenced = new Set([...markdownImageSources(markdown), ...renderPageSources(message)]);
          const generated = toolResultImageSources(message);
          check = (source) => (referenced.has(source) || generated.has(comparablePath(source)) ? inspect(source) : { status: 'error' });
        }
        const results = [];
        for (const source of sources) {
          try {
            const inspected = await check(source);
            if (inspected.status !== 'ready') {
              results.push({ source, status: inspected.status });
              continue;
            }
            const grant = inspected.outsideWorkspace
              ? await mintOutsideFileGrant(inspected.path, {
                scopes: ['raw'],
                fsPromises,
                path,
                crypto,
              })
              : null;
            results.push({
              source,
              status: 'ready',
              path: inspected.path,
              outsideFileGrant: grant?.outsideFileGrant,
              expiresAt: grant?.expiresAt,
            });
          } catch {
            results.push({ source, status: 'error' });
          }
        }
        return res.json({ results });
      } catch (error) {
        console.warn('[MarkdownImageGrants] failed to prepare images:', (hasErrorMessage(error) && error.message) || error);
        return res.status(503).json({ error: 'Failed to prepare session images' });
      }
    },
  );
};
