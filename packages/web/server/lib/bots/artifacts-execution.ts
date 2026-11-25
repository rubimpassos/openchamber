import { createBotArtifactCapture } from './artifacts-capture.js';
import { z } from 'zod';
import { botArtifactBindingFromSession, sameArtifactBinding, BotArtifactError } from './artifacts-contract.js';
import { createBotArtifactService, registerBotArtifactServiceRoutes } from '../agent-server/bot-artifact-services.js';
import type { BotArtifactBinding, BotArtifactManifest, BotArtifactMetadata } from './artifacts-contract.js';
import type { Application } from '../shared/http-contracts.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { SessionClient } from '../openchamber-sessions/opencode-client-contract.js';
import type { RenderedPageOrigin, RenderedPageProjection } from '../openchamber-control/page-projection.js';
import { createBotConversationDelivery } from './conversation-delivery.js';

type Options = {
  readonly dataDir: string;
  readonly readSession: (sessionId: string) => ReturnType<SessionClient['session']['get']>;
  readonly updateMetadata: (sessionId: string, patch: SessionMetadata) => Promise<void>;
  readonly resolveBinding?: (sessionId: string) => Promise<BotArtifactBinding | null>;
  readonly publish?: (manifest: BotArtifactManifest, bytes: Uint8Array) => Promise<BotArtifactMetadata>;
  readonly readPage?: (origin: RenderedPageOrigin) => Promise<RenderedPageProjection | null>;
  readonly stopProducer?: (binding: BotArtifactBinding) => Promise<void>;
  readonly privatePlacement?: 'agent' | 'space';
};

export function createBotArtifactExecution(options: Options) {
  const sessionSchema = z.object({ id: z.string().min(1), location: z.object({ directory: z.string().min(1) }) }).passthrough();
  const sessionRead = z.union([sessionSchema, z.object({ data: sessionSchema }).transform(({ data }) => data)]);
  const canonical = async (sessionId: string) => {
    const session = sessionRead.parse(await options.readSession(sessionId));
    if (session.id !== sessionId) throw new BotArtifactError('BOT_ARTIFACT_BINDING_MISMATCH', 403);
    const binding = botArtifactBindingFromSession(session);
    if (options.resolveBinding) {
      const registered = await options.resolveBinding(sessionId);
      if (registered) {
        if (registered.sessionId !== sessionId || registered.directory !== session.location.directory
          || binding && !sameArtifactBinding(registered, binding)) throw new BotArtifactError('BOT_ARTIFACT_BINDING_REQUIRED', 403);
        return registered;
      }
      if (binding) throw new BotArtifactError('BOT_ARTIFACT_BINDING_REQUIRED', 403);
    }
    return binding;
  };
  let captureOptions: Parameters<typeof createBotArtifactCapture>[0] = {
    dataDir: options.dataDir, resolveSession: canonical,
    onCaptured: async (manifest) => { await options.updateMetadata(manifest.binding.sessionId, {
      openchamber: { botArtifactCaptured: manifest.metadata.id },
    }); },
  };
  if (options.publish) captureOptions = { ...captureOptions, publish: options.publish };
  const capture = createBotArtifactCapture(captureOptions);
  const delivery = createBotConversationDelivery({ dataDir: options.dataDir, resolveSession: canonical, updateMetadata: options.updateMetadata });
  let serviceOptions: Parameters<typeof createBotArtifactService>[0] = { capture, delivery, resolveBinding: options.resolveBinding ?? canonical,
    readPage: async (manifest) => manifest.metadata.interaction === 'none' || manifest.metadata.interaction === 'share' ? { kind: 'show' }
      : options.readPage ? options.readPage({ ...manifest.metadata.source, directory: manifest.binding.directory }) : null,
  };
  if (options.stopProducer) serviceOptions = { ...serviceOptions, stopProducer: options.stopProducer };
  const service = createBotArtifactService(serviceOptions);
  return { capture, service, delivery,
    registerRoutes: (app: Application, placement: 'agent' | 'space') =>
      registerBotArtifactServiceRoutes(app, { service, placement, isAllowed: () => options.privatePlacement === placement }),
  };
}
