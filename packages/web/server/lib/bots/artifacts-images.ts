import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { inspectLocalImage } from '../markdown-image-grants/inspect-image.js';
import { fitRenderPageImages, renderPageImageSources } from '../openchamber-control/render-page.js';
import { BOT_ARTIFACT_IMAGE_BYTES, BOT_ARTIFACT_ASSET_BYTES, BotArtifactError, artifactHash } from './artifacts-contract.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import type { BotArtifactAsset } from './artifacts-contract.js';
import type { LocalImageInspection } from '../markdown-image-grants/inspect-image.js';
import { markdownImageSources } from '../markdown-image-grants/discovery.js';
import type { BotArtifactBody } from './artifacts-contract.js';

const externalImages = (body: string) => [...new Set([
  ...Array.from(body.matchAll(/(?:\bsrc\s*=\s*["']?|url\(\s*["']?)(https?:\/\/[^"'`<>\s)]+)/gi), (match) => match[1] ?? ''),
  ...Array.from(body.matchAll(/(["'`])(https?:\/\/(?:(?!\1)[^<>\n])*?\.(?:png|jpe?g|gif|webp)(?:\?[^"'`<>\n]*)?)\1/gi), (match) => match[2] ?? ''),
])];

const unavailableSource = (error: unknown): LocalImageInspection => {
  if (hasSourceControlErrorCode(error)) {
    switch (error.code) {
      case 'ENOENT': return { status: 'missing' };
      case 'EACCES': case 'EPERM': case 'ELOOP': case 'ENOTDIR': case 'ENAMETOOLONG': case 'EINVAL':
      case 'ERR_INVALID_ARG_VALUE': return { status: 'error' };
    }
  }
  throw error;
};

export async function captureArtifactImages(body: BotArtifactBody, location: { readonly directory: string; readonly temporaryRoot: string }) {
  const sources = new Set<string>();
  switch (body.format) {
    case 'html':
      for (const source of [...renderPageImageSources(body.content), ...externalImages(body.content)]) sources.add(source);
      break;
    case 'ui':
      for (const match of body.content.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
        let literal: string;
        try { literal = JSON.parse(match[0]); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        for (const source of [...renderPageImageSources(`"${literal}"`), ...externalImages(`"${literal}"`), ...markdownImageSources([literal])]) {
          if (!source.startsWith('data:')) sources.add(source);
        }
      }
      break;
    default: assertNever(body);
  }
  const external = [...sources].filter((source) => /^(?:https?:)?\/\//i.test(source));
  const local = [...sources].filter((source) => !external.includes(source));
  if (local.length + external.length > 256) throw new BotArtifactError('BOT_ARTIFACT_TOO_MANY_ASSETS', 413);
  if (local.length + external.length === 0) return [];
  const captured = new Map<string, BotArtifactAsset>();
  let capturedBytes = 0;
  let full = false;
  await fs.mkdir(location.temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(location.temporaryRoot, 'images-'));
  try {
    const { images } = await fitRenderPageImages(local, async (source) => {
      const inspected = await inspectLocalImage({ source, directory: location.directory, fsPromises: fs, path }).catch(unavailableSource);
      switch (inspected.status) {
        case 'missing': case 'error': return inspected;
        case 'ready': {
          full = full || capturedBytes + inspected.size > BOT_ARTIFACT_ASSET_BYTES;
          if (full) return inspected;
          let bytes: Buffer;
          try {
            const canonical = await fs.realpath(inspected.path);
            if (!inspected.outsideWorkspace) {
              const root = await fs.realpath(location.directory);
              const relative = path.relative(root, canonical);
              if (relative.startsWith('..') || path.isAbsolute(relative)) return { status: 'error' };
            }
            const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > BOT_ARTIFACT_IMAGE_BYTES) return { status: 'error' };
              const buffer = Buffer.alloc(stat.size + 1);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              if (bytesRead > BOT_ARTIFACT_IMAGE_BYTES || bytesRead !== stat.size) return { status: 'error' };
              bytes = buffer.subarray(0, bytesRead);
            } finally { await handle.close(); }
          } catch (error) {
            if (error instanceof Error) return unavailableSource(error);
            throw error;
          }
          const frozen = path.join(temporary, `${artifactHash(source)}.png`);
          await fs.writeFile(frozen, bytes, { flag: 'wx', mode: 0o600 });
          const checked = await inspectLocalImage({ source: frozen, directory: temporary, fsPromises: fs, path });
          if (checked.status !== 'ready') return { status: 'error' };
          const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg'
            : bytes.subarray(0, 3).toString('ascii') === 'GIF' ? 'image/gif' : 'image/webp';
          captured.set(source, { source, status: 'ready', mime, data: bytes.toString('base64') });
          capturedBytes += bytes.length;
          return { ...checked, path: inspected.path, outsideWorkspace: inspected.outsideWorkspace };
        }
        default: return assertNever(inspected);
      }
    });
    const assets: BotArtifactAsset[] = images.map((image) => {
      switch (image.status) {
        case 'ready': {
          const asset = captured.get(image.source);
          if (!asset) throw new BotArtifactError('BOT_ARTIFACT_IMAGE_CAPTURE_FAILED', 500);
          return asset;
        }
        case 'missing': return { source: image.source, status: 'missing' };
        case 'error': return { source: image.source, status: 'rejected' };
        case 'too-heavy': return { source: image.source, status: 'too-heavy' };
        default: return assertNever(image);
      }
    });
    assets.push(...external.map((source) => ({ source, status: 'external' as const })));
    return assets;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

function assertNever(value: never): never { throw new TypeError(`Unexpected image inspection: ${String(value)}`); }
