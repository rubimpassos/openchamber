import { z } from 'zod';
import { BotServiceError, branch as branchSchema, sha, text } from './services/contracts.js';
import { botMigrationPathSchema, transferSourceSchema } from '../spaces/transfer-bundle.js';
import type { BotItem } from './schema.js';
import type { BotDefinition } from './config.js';
import type { createBotServiceContext } from './service-context.js';
import type { advanceBotCheckout } from './production-git.js';
import type { removeWorktree } from '../git/service.js';

export function fail(code: string): never {
  throw new BotServiceError(code, 'The bot checkout could not be verified. Retained files and refs require inspection.');
}
export const associationSchema = z.object({ spaceId: z.string().regex(/^[a-f0-9]{12}$/),
  source: transferSourceSchema }).strict().refine((value) => value.source.kind === 'bot-checkout');
export const ownerFields = { version: z.literal(1), projectId: text, projectPath: text, itemId: text, botId: text,
  repositoryId: text, key: text, directory: text, branch: branchSchema, baseBranch: branchSchema, baseSha: sha,
  identityId: text, identityRevision: z.number().int().positive(),
  gitDirectory: text.optional(), gitIdentity: text.optional(), directoryIdentity: text.optional() };
export const ownerSchema = z.object({ ...ownerFields, publicationBranch: branchSchema.optional(),
  state: z.enum(['preparing', 'ready', 'adopting', 'removing', 'removed']), removeHead: sha.optional(),
  adoption: z.object({ fromSha: sha, resultSha: sha, resultRef: z.string().regex(/^refs\/openchamber\/spaces\/[a-f0-9]{12}\/result$/),
    association: associationSchema.optional() }).strict().optional(),
}).strict().refine((record) => (record.state === 'adopting') === Boolean(record.adoption), 'Only an adopting checkout carries a transfer intent');
export const reservationsSchema = z.object({ version: z.literal(1), repositoryId: text,
  reservations: z.array(z.object({ publicationBranch: branchSchema, owner: z.object(ownerFields).strict() }).strict()),
}).strict().refine((registry) => registry.reservations.every((entry) => entry.owner.repositoryId === registry.repositoryId)
  && new Set(registry.reservations.map((entry) => entry.publicationBranch)).size === registry.reservations.length
  && new Set(registry.reservations.map((entry) => `${entry.owner.botId}\0${entry.owner.itemId}`)).size === registry.reservations.length,
'Publication branches and owners must be unique within their repository');

export type CheckoutOwner = z.output<typeof ownerSchema>;
export type Reservations = z.output<typeof reservationsSchema>;
export type Reservation = Reservations['reservations'][number];
export type MigrationRequest = { readonly trustedMigrationPath?: z.output<typeof botMigrationPathSchema> | undefined };
export type CheckoutLocation = { readonly project: { readonly id: string }; readonly item: { readonly id: string } };
export type CheckoutItem = Pick<BotItem, 'id' | 'botId' | 'worktree' | 'branch' | 'publicationBranch'> & {
  readonly pr?: object | undefined;
  readonly effects?: readonly Pick<BotItem['effects'][number], 'key' | 'kind' | 'state'>[];
};
export type CheckoutIdentityRequest = MigrationRequest & {
  readonly project: { readonly id: string; readonly path: string };
  readonly bot: Pick<BotDefinition, 'id'>;
  readonly item: Pick<CheckoutItem, 'id' | 'worktree' | 'branch' | 'publicationBranch'> & { readonly botId?: string | undefined };
  readonly key?: string | undefined;
};
export type CheckoutRequest = CheckoutIdentityRequest & { readonly bot: BotDefinition; readonly item: CheckoutItem };
export type Checkout = Pick<CheckoutOwner, 'directory' | 'branch' | 'baseBranch' | 'baseSha'>;
export type CheckoutContext = Pick<ReturnType<typeof createBotServiceContext>, 'github' | 'author'>;
export type CheckoutOptions = {
  readonly dataDir: string;
  readonly context: CheckoutContext;
  readonly readItem: (projectId: string, itemId: string) => Promise<CheckoutItem | null | undefined>;
  readonly disposeInstance?: NonNullable<Parameters<typeof removeWorktree>[1]>['disposeInstance'] | undefined;
  readonly advanceCheckout?: typeof advanceBotCheckout | undefined;
};
export type AdoptionRequest = CheckoutRequest & {
  readonly resultSha: string;
  readonly spaceId?: string;
  readonly association?: z.input<typeof associationSchema>;
};
export type CheckoutSnapshot = {
  readonly baseSha: string; readonly headSha: string; readonly baseBranch: string; readonly remoteSha: string | null;
  readonly changes: { oldPath?: string | undefined; newPath?: string | undefined }[]; readonly diff: string;
  testSha?: string | undefined; fixSha?: string | undefined; testFiles?: string[] | undefined;
};
export const checkoutOf = (record: CheckoutOwner): Checkout => ({ directory: record.directory, branch: record.branch, baseBranch: record.baseBranch, baseSha: record.baseSha });
export const sourceOfRecord = (record: CheckoutOwner) => ({ kind: 'bot-checkout' as const, projectDirectory: record.projectPath,
  projectId: record.projectId, botId: record.botId, itemId: record.itemId, checkoutKey: record.key });

export function adoptionOf(record: CheckoutOwner): NonNullable<CheckoutOwner['adoption']> {
  if (!record.adoption) throw new TypeError('An adopting checkout requires its durable intent');
  return record.adoption;
}
