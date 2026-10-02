/**
 * Subagent sessions carry their agent in the title: OpenCode 1.x and
 * oh-my-openagent name them `<description> (@<agent> subagent)`. The sidebar
 * shows the description and the agent as a label instead.
 */
const SUBAGENT_SUFFIX = /^(.*?)\s*\(@([^()]+?) subagent\)\s*$/;

export type SubagentTitle = { title: string; agent: string | null };

export const splitSubagentTitle = (title: string): SubagentTitle => {
  const match = SUBAGENT_SUFFIX.exec(title);
  if (!match || !match[1]) return { title, agent: null };
  return { title: match[1], agent: match[2].trim() };
};

/**
 * The agent label of a session row: the one its title names, else the
 * session's own agent when it is a child (a native 2.x subagent keeps the
 * agent on the session, not in the title). Top-level sessions get none.
 */
export const sessionAgentLabel = (
  session: { title?: string; parentID?: string | null; agent?: string | null },
): SubagentTitle => {
  const split = splitSubagentTitle(session.title ?? '');
  if (split.agent) return split;
  return { title: split.title, agent: session.parentID && session.agent ? session.agent : null };
};
