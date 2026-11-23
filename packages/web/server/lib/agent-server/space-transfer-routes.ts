import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Router } from '../shared/http-contracts.js';
import type { AgentSpaceTransferOptions } from './space-transfer.js';
import type { ReadTransferProjectSettings } from './registered-transfer-project.js';
import { failureProperty } from '../spaces/failure.js';
import { parseJson } from '../spaces/json.js';
import type { TransferOwner } from '../spaces/code-in.js';
import { readBoundedBody } from './agent-upstream.js';
import { createAgentSpaceTransfer } from './space-transfer.js';
import { registeredTransferProject, registeredTransferDirectorySchema as directorySchema } from './registered-transfer-project.js';
export { registeredTransferDirectory } from './registered-transfer-project.js';
import { requireSpaceId } from '../spaces/labels.js';
import { SPACE_TRANSFER_ROUTE, botMigrationPathSchema, bundleFailure, receiveBundle, streamBundle, transferCaps, transferSourceSchema, withBundleDirectory } from '../spaces/transfer-bundle.js';

const snapshotSchema = z.object({ mode: z.enum(['clean', 'uncommitted']) }).strict();
const branchSchema = z.object({ branch: z.string().min(1).max(256) }).strict();
const failureCodeSchema = z.string().catch('agent_transfer_failed');
const resultSchema = z.object({ start: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  result: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict();
type SpaceTransfer = ReturnType<typeof createAgentSpaceTransfer>;
type TransferReply = Awaited<ReturnType<SpaceTransfer[keyof SpaceTransfer]>>;

export interface SpaceTransferRoutesOptions extends Omit<AgentSpaceTransferOptions, 'caps'> {
  readonly agent?: boolean;
  readonly readSettings: ReadTransferProjectSettings;
  readonly caps?: AgentSpaceTransferOptions['caps'];
  readonly resolveTransferSource?: (source: Extract<NonNullable<TransferOwner['source']>, { kind: 'bot-checkout' }>, options: Pick<TransferOwner, 'trustedMigrationPath'>) => Promise<string>;
}

export function registerSpaceTransferRoutes(app: Router, { agent = false, readSettings, dataDir, resolveGitPath, resolveTransferSource, environment, caps = transferCaps() }: SpaceTransferRoutesOptions) {
  if (!agent) return;
  const transfer = createAgentSpaceTransfer({ dataDir, caps, resolveGitPath, environment });
  app.all<unknown, { spaceId: string; operation: string }>(`${SPACE_TRANSFER_ROUTE}/:spaceId/:operation`, async (req, res) => {
    const timer = setTimeout(() => req.destroy(bundleFailure('agent_transfer_timeout')), caps.timeoutMs);
    timer.unref();
    try {
      const spaceId = requireSpaceId(req.params.spaceId);
      const url = new URL(req.originalUrl, 'http://agent');
      const allowed = req.params.operation === 'result' ? ['directory', 'source', 'trustedMigrationPath', 'start', 'result']
        : req.method === 'GET' && req.params.operation === 'snapshot' ? ['directory', 'source', 'trustedMigrationPath', 'base'] : ['directory', 'source', 'trustedMigrationPath'];
      if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw bundleFailure('agent_transfer_invalid_request');
      const parent = await registeredTransferProject(url.searchParams.get('directory'), readSettings);
      let source: NonNullable<TransferOwner['source']> = { kind: 'project', directory: parent.directory };
      const rawSource = url.searchParams.get('source');
      if (rawSource !== null) {
        if (Buffer.byteLength(rawSource) > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        try { source = transferSourceSchema.parse(parseJson(rawSource)); }
        catch { throw bundleFailure('agent_transfer_invalid_request'); }
      }
      const parentPath = source.kind === 'project' ? source.directory : source.projectDirectory;
      if (source.kind === 'project') {
        if (await fs.realpath(parentPath).catch(() => null) !== parent.directory) throw bundleFailure('agent_project_mismatch');
        source = { kind: 'project', directory: parent.directory };
      } else if (await fs.realpath(parentPath).catch(() => null) !== parent.directory) throw bundleFailure('agent_project_mismatch');
      let directory = parent.directory;
      let trustedMigrationPath: TransferOwner['trustedMigrationPath'];
      const rawMigrationPath = url.searchParams.get('trustedMigrationPath');
      if (rawMigrationPath !== null) {
        if (Buffer.byteLength(rawMigrationPath) > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        try { trustedMigrationPath = botMigrationPathSchema.parse(parseJson(rawMigrationPath)); }
        catch { throw bundleFailure('agent_transfer_invalid_request'); }
        if (source.kind !== 'bot-checkout') throw bundleFailure('agent_transfer_invalid_request');
      }
      if (source.kind === 'bot-checkout') {
        if (source.projectId !== parent.id) throw bundleFailure('agent_project_mismatch');
        if (!resolveTransferSource) throw bundleFailure('agent_source_unavailable');
        directory = await resolveTransferSource(source, { trustedMigrationPath });
        if (!directorySchema.safeParse(directory).success) throw bundleFailure('agent_directory_invalid');
      }
      const json = async <Schema extends z.ZodType>(schema: Schema): Promise<z.output<Schema>> => {
        const raw = req.body === undefined ? await readBoundedBody(req, caps.metadataBytes) : JSON.stringify(req.body);
        if (Buffer.byteLength(raw) > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        let value;
        try { value = parseJson(raw); } catch { throw bundleFailure('agent_metadata_invalid'); }
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw bundleFailure('agent_transfer_invalid_request');
        return parsed.data;
      };
      const answer = (value: TransferReply) => {
        const body = JSON.stringify(value);
        if (Buffer.byteLength(body) > caps.metadataBytes) throw bundleFailure('agent_metadata_too_large');
        res.type('json').send(body);
      };
      const operation = `${req.method} ${req.params.operation}`;
      switch (operation) {
        case 'POST snapshot': return answer(await transfer.snapshot(directory, spaceId, (await json(snapshotSchema)).mode, source, trustedMigrationPath));
        case 'GET snapshot': return answer(await transfer.readSnapshot(directory, spaceId, url.searchParams.get('base'), source, trustedMigrationPath));
        case 'GET bundle':
          return await withBundleDirectory({ caps }, async ({ directory: temporary }) => {
            const file = path.join(temporary, 'snapshot.bundle');
            await transfer.exportSnapshot(directory, spaceId, file, source, trustedMigrationPath);
            res.type('application/x-git-bundle');
            await streamBundle(createReadStream(file), res, caps);
          });
        case 'POST result': {
          const parsed = resultSchema.safeParse({ start: url.searchParams.get('start'), result: url.searchParams.get('result') });
          if (!parsed.success) throw bundleFailure('agent_transfer_invalid_request');
          return await withBundleDirectory({ caps }, async ({ directory: temporary }) => {
            const file = path.join(temporary, 'result.bundle');
            await receiveBundle(req, file, caps);
            answer(await transfer.promote(directory, spaceId, file, parsed.data, source, trustedMigrationPath));
          });
        }
        case 'GET apply-state': return answer(await transfer.applyState(directory, spaceId, source, trustedMigrationPath));
        case 'POST apply-branch': return answer(await transfer.applyBranch(directory, spaceId, (await json(branchSchema)).branch, source, trustedMigrationPath));
        case 'POST apply-changes': await json(z.object({}).strict()); return answer(await transfer.applyChanges(directory, spaceId, source, trustedMigrationPath));
        case 'DELETE refs': return answer(await transfer.removeRefs(directory, spaceId, source, trustedMigrationPath));
        default: return res.status(404).json({ code: 'agent_transfer_operation_invalid' });
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const code = failureCodeSchema.parse(failureProperty(error, 'code'));
      res.status(code === 'agent_project_unregistered' ? 403 : 400).json({ code, error: code });
    } finally { clearTimeout(timer); }
  });
}
