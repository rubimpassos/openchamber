import { SpaceError, spaceErrorProperty } from './errors.js';
import type { createSpaceManager } from './manager.js';
import type { createSpaceRecords } from './space-records.js';
import type { createGatekeeperChannel } from './gatekeeper-channel.js';
import type { SpaceGrant } from './space-records.js';
import type { McpSubjectResult } from './journey-contracts.js';

type Manager = ReturnType<typeof createSpaceManager>;
type ListedSpace = Awaited<ReturnType<Manager['listAllSpaces']>>['spaces'][number];
type CleanupSpace = {
  readonly id: string;
  readonly name: ListedSpace['name'];
  readonly state: string;
  readonly placeId: string | undefined;
  readonly projectDirectory: string | null;
};
type ArchiveRequest = {
  readonly spaceId: string;
  readonly name: ListedSpace['name'];
  readonly projectDirectory: string | null;
  readonly running: boolean;
  readonly allowUnsaved: boolean;
};
type CleanupDependencies<Archive, Removal extends { readonly removed: boolean }> = {
  readonly manager: Pick<Manager, 'startSpace' | 'stopSpace' | 'verify'>;
  readonly records: Pick<ReturnType<typeof createSpaceRecords>, 'read'>;
  readonly gatekeeper: Pick<ReturnType<typeof createGatekeeperChannel>, 'readPolicy'>;
  readonly archiveChats: ((request: ArchiveRequest) => Promise<Archive>) | null;
  readonly placeKindOf: (placeId: string | undefined) => string;
  readonly logger: Pick<Console, 'warn'>;
  readonly exclusive: <Result>(spaceId: string, work: () => Promise<Result>) => Promise<Result>;
  readonly requireNotPending: (spaceId: string) => void;
  readonly requireListed: (spaceId: string) => Promise<CleanupSpace>;
  readonly requireStartActivation: (spaceId: string, activation: null) => void;
  readonly strayStops: ReadonlyMap<string, Promise<void>>;
  readonly isClosing: () => boolean;
  readonly removeUnlocked: (spaceId: string, options: { readonly collect: () => Promise<void> }) => Promise<Removal>;
  readonly syncMcpSubject: (spaceId: string, grants: SpaceGrant[]) => Promise<McpSubjectResult>;
  readonly onSpacesChanged: () => void;
};

export function createSpaceCleanup<Archive, Removal extends { readonly removed: boolean }>({
  manager, records, gatekeeper, archiveChats, placeKindOf, logger, exclusive,
  requireNotPending, requireListed, requireStartActivation, strayStops, isClosing,
  removeUnlocked, syncMcpSubject, onSpacesChanged,
}: CleanupDependencies<Archive, Removal>) {
  const saveChatsOf = async (space: CleanupSpace, allowUnsaved: boolean, startStopped = true) => {
    if (!archiveChats) return null;
    let running = space.state === 'running';
    let started = false;
    if (startStopped && !running && space.state === 'exited' && placeKindOf(space.placeId) !== 'host-root') {
      try {
        await manager.startSpace({ spaceId: space.id });
        running = true;
        started = true;
      } catch (error) {
        logger.warn?.(`[spaces] space ${space.id} did not start to give its chats: ${spaceErrorProperty(error, 'code') ?? spaceErrorProperty(error, 'message') ?? error}`);
      }
    }
    try {
      return await archiveChats({ spaceId: space.id, name: space.name, projectDirectory: space.projectDirectory ?? null, running, allowUnsaved });
    } catch (error) {
      if (started) {
        try {
          await manager.stopSpace({ spaceId: space.id });
        } catch (stopError) {
          logger.warn?.(`[spaces] space ${space.id} started for its chats is still running: ${spaceErrorProperty(stopError, 'code') ?? spaceErrorProperty(stopError, 'message') ?? stopError}`);
        }
      }
      throw error;
    }
  };

  const cleanupBotSpace = (spaceId: string, { remove, collect }: { readonly remove: boolean; readonly collect: (final: boolean) => Promise<void> }) => exclusive(spaceId, async () => {
    requireNotPending(spaceId);
    await strayStops.get(spaceId);
    const space = await requireListed(spaceId);
    const temporary = space.state === 'exited';
    const { record, status } = records.read(spaceId);
    if (temporary) {
      if (isClosing()) throw new SpaceError('isolated_spaces_off', 'Isolated spaces are being turned off.');
      requireStartActivation(spaceId, null);
      if (status !== 'ok') throw new SpaceError('space_record_unreadable', 'The retained access of this space cannot be read.');
    }
    const mcpGrants = temporary ? (record?.grants ?? []).filter((grant) => grant.kind === 'mcp') : [];
    let suspendedMcp = false;
    let removed = false;
    let outcome: Removal | null = null;
    let restoration: McpSubjectResult | null = null;
    try {
      if (temporary) {
        await manager.stopSpace({ spaceId });
        if (mcpGrants.length) {
          const answer = await syncMcpSubject(spaceId, []);
          if (!answer.ok) throw new SpaceError(answer.code ?? 'protected_mcp_unavailable', 'Protected MCP access could not be suspended for cleanup.');
          suspendedMcp = true;
        }
        await manager.startSpace({ spaceId });
        const policy = await gatekeeper.readPolicy(spaceId);
        if (policy.mode !== 'allowlist' || policy.domains.length || policy.grants.length) {
          throw new SpaceError('space_cleanup_access_open', 'The temporary cleanup runtime must have no network or model access.');
        }
        const violations = await manager.verify(spaceId);
        if (violations.length) throw new SpaceError('space_verification_failed', 'The temporary cleanup runtime could not be verified.', { violations });
      }
      await collect(!remove);
      if (remove) {
        outcome = await removeUnlocked(spaceId, { collect: () => collect(true) });
        removed = outcome.removed;
      }
    } finally {
      if (!remove || (temporary && !removed)) {
        await manager.stopSpace({ spaceId });
        if (suspendedMcp) {
          restoration = await syncMcpSubject(spaceId, mcpGrants);
        }
      }
      onSpacesChanged();
    }
    if (restoration && !restoration.ok) throw new SpaceError(restoration.code ?? 'protected_mcp_unavailable', 'Protected MCP access could not be restored after cleanup stopped.');
    return outcome;
  });
  return { saveChatsOf, cleanupBotSpace };
}
