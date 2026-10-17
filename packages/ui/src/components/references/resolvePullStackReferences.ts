import type { ComposerReference } from '@/components/chat/composer/composerReferences';
import type { GitHubRepoSelector, PullStack, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';

/** Context reads stay bounded to one request at a time and a failed member never stops the chain. */
export async function resolvePullStackReferences(stack: PullStack, project: GitHubRepoSelector, dependencies: {
  readonly context: SourceControlReadContext;
  readonly sourceControl: Pick<SourceControlAPI, 'changeRequestContext'>;
  readonly isCurrent: () => boolean;
}) {
  const references: ComposerReference[] = [];
  const failures: Array<{ number: number; error: string }> = [];
  for (const member of stack.members) {
    if (!dependencies.isCurrent()) break;
    try {
      const payload = await dependencies.sourceControl.changeRequestContext(dependencies.context, member.number, {
        includeDiff: true, includeCIDetails: true, project: { owner: project.owner, name: project.repo },
      });
      if (!payload.changeRequest) throw new Error(`Pull request #${member.number} was not returned`);
      const pull = payload.changeRequest;
      references.push({
        kind: 'change-request', provider: 'github', number: pull.number, title: pull.title, url: pull.url,
        head: pull.head, base: pull.base, includeDiff: true,
        followStack: member.number === stack.current ? true : undefined,
        contextText: `Source control change request context (JSON)\n${JSON.stringify(payload, null, 2)}`,
      });
    } catch (error) {
      failures.push({ number: member.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const summary = `Pull request stack (bottom to top)\n${JSON.stringify({
    source: stack.source, trunk: stack.trunk, current: stack.current,
    members: stack.members.map(({ number, title, head, base, url, state }) => ({ number, title, head, base, url, state })),
    branches: stack.branches, failedContext: failures.map((failure) => failure.number),
  }, null, 2)}`;
  return { references, failures, summary };
}
