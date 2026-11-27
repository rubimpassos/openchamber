export const BOT_TOOL_ACTIONS = [
  { action: 'item.report', title: 'Report bot evidence', description: 'Attach evidence to this item. Input is {evidence:[{source,summary,url?}],critical?:boolean}. This action accepts no operationId. Mark critical only for an incident or security issue that needs immediate attention.' },
  { action: 'item.ask', title: 'Ask about the bot item', description: 'Ask a person a question and wait. Supply a stable operationId and reuse it for retries. People are IDs from the approved project directory; requestedRole is an optional role from that directory.' },
  { action: 'git.push', title: 'Publish bot commits', description: 'Publish the owned item branch using the bot identity. The server chooses the repository, branch and commits.' },
  { action: 'pr.open', title: 'Open the bot pull request', description: 'Open the item pull request after server judgment. The server supplies evidence, proof and destination.' },
  { action: 'pr.comment', title: 'Comment on the bot pull request', description: 'Comment on this item pull request using the bot identity.' },
  { action: 'jira.comment', title: 'Comment on the bot Jira issue', description: 'Comment on this item Jira issue using the bot identity.' },
  { action: 'jira.transition', title: 'Transition the bot Jira issue', description: 'Apply the configured done transition after the item pull request merged.' },
  { action: 'discord.send', title: 'Send a bot Discord message', description: 'Send a message to this item configured Discord destination using the bot app.' },
  { action: 'item.answer', title: 'Answer a waiting bot item', description: 'Pass the user\'s own answer to the question an item waits on. Input is {operationId, questionKey, text}; the main bot chat also names projectId and itemId. Never answer for the user.' },
  { action: 'bot.items', title: 'List the bot work', description: 'Main bot chat only. Lists every item of this bot with its project, state, wait and pending question, plus the projects it may access.' },
  { action: 'bot.start', title: 'Start bot work', description: 'Main bot chat only. Starts a new item in a project the bot may access. Input is {operationId, projectId, title, description?}.' },
];

export const BOT_TOOL_PARAMETERS = {
  operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$', description: 'Stable ID for this logical write. Keep the same ID after an uncertain result; never invent another ID to retry it.' },
  body: { type: 'string', description: 'Message text for a comment or Discord send.' },
  question: { type: 'string', description: 'The question for item.ask.' },
  people: { type: 'array', items: { type: 'string' }, description: 'Approved person IDs for item.ask.' },
  requestedRole: { type: 'string', minLength: 1, maxLength: 200, description: 'Project people-directory role for item.ask when area owners are unavailable.' },
  critical: { type: 'boolean', description: 'Whether reported evidence needs an immediate incident alert.' },
  questionKey: { type: 'string', description: 'For item.answer: the questionKey from the coordinator progress.' },
  text: { type: 'string', description: 'For item.answer: the user\'s answer.' },
  projectId: { type: 'string', description: 'For the main bot chat: the project of the item or of new work.' },
  itemId: { type: 'string', description: 'For item.answer from the main bot chat: the waiting item.' },
  title: { type: 'string', description: 'For bot.start: the title of the new work.' },
  description: { type: 'string', description: 'For bot.start: what the work should achieve.' },
  evidence: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, summary: { type: 'string' }, url: { type: 'string' } }, required: ['source', 'summary'], additionalProperties: false } },
};

export const BOT_RENDER_PARAMETERS = {
  artifactKind: { type: 'string', enum: ['evidence', 'decision'], description: "For a recorded bot session, categorize this durable page as evidence or decision. Defaults to evidence. Choose any HTML or OpenUI representation; this category does not prescribe its content. Worker sessions can only show read-only pages; the item's conversation can ask through the normal page controls." },
  artifactFor: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: "For a recorded bot session: the ID of the required artifact this page presents, from the bot's artifact list. The work counts as done only when every required artifact has a page." },
};
