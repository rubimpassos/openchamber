import { BotServiceError } from './contracts.js';
import type { BotOperation, BotOperationInput, BotOperationTarget, BotServiceEffect } from './contracts.js';

type PublicationTarget = Pick<BotOperationTarget<'git.push'>, 'repositoryId'>;
type PublicationEffect = Omit<BotServiceEffect, 'target' | 'inputDigest'> & (
  | { readonly authority: BotServiceEffect['authority'] & { readonly service: 'github' }; readonly target: PublicationTarget }
  | { readonly authority: BotServiceEffect['authority'] & { readonly service: 'jira' | 'discord' }; readonly target: BotServiceEffect['target'] }
);
type PublicationInput = BotOperationInput<BotOperation>;
type OwnedPublication = {
  readonly publicationBranch: string;
  readonly localBranch: string;
  readonly directory: string;
  readonly identityId: string;
  readonly identityRevision: number;
};
type PublicationResolver = (key: { readonly repositoryId: string; readonly botId: string; readonly itemId: string }) => Promise<OwnedPublication | null>;
type GitHubEffect = Extract<PublicationEffect, { readonly target: PublicationTarget }>;
const isGitHubEffect = (effect: PublicationEffect): effect is GitHubEffect => effect.authority.service === 'github';

const refuse = () => { throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The operation differs from the privately reserved bot branch.'); };

export function createBotPublicationAuthority({ resolvePublication }: { readonly resolvePublication: PublicationResolver }) {
  const validate = (effect: Pick<PublicationEffect, 'authority' | 'itemId' | 'publicationBranch' | 'operation'>, input: PublicationInput) => {
    if (effect.authority.service !== 'github') return;
    const local = `bot/${effect.itemId}`;
    const remote = effect.publicationBranch ?? local;
    const branch = 'branch' in input ? input.branch : undefined;
    const localBranch = 'localBranch' in input ? input.localBranch : undefined;
    if (branch !== undefined && branch !== remote) refuse();
    if (effect.operation === 'git.push' && (localBranch ?? branch) !== local) refuse();
  };
  const assertOwned = (effect: PublicationEffect, input: PublicationInput, owned: OwnedPublication | null) => {
    if (effect.publicationBranch !== undefined && (!owned || owned.publicationBranch !== effect.publicationBranch
      || owned.localBranch !== `bot/${effect.itemId}` || owned.identityId !== effect.authority.identityId
      || owned.identityRevision !== effect.authority.identityRevision
      || effect.operation === 'git.push' && (!('directory' in input) || owned.directory !== input.directory))) refuse();
  };
  return {
    validate,
    async prepare<Effect extends PublicationEffect>(effect: Effect, input: PublicationInput): Promise<Effect> {
      if (!isGitHubEffect(effect)) return effect;
      const owned = await resolvePublication({ repositoryId: effect.target.repositoryId, botId: effect.botId, itemId: effect.itemId });
      const captured = owned ? { ...effect, publicationBranch: owned.publicationBranch } : effect;
      validate(captured, input);
      assertOwned(captured, input, owned);
      return captured;
    },
    async assertCurrent(effect: PublicationEffect, input: PublicationInput) {
      if (effect.publicationBranch === undefined) return;
      if (!isGitHubEffect(effect)) return refuse();
      assertOwned(effect, input, await resolvePublication({ repositoryId: effect.target.repositoryId, botId: effect.botId, itemId: effect.itemId }));
    },
  };
}
