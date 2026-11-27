const explanations = {
  BOT_CONVERSATION_SCOPE_MISMATCH: 'The server could not match the item conversation with its recorded project. Resume retries; if it repeats, the conversation record needs inspection.',
  BOT_CONVERSATION_SESSION_MISMATCH: 'The conversation session no longer matches its record, for example after it was moved or edited. Resume retries the check.',
  BOT_CONVERSATION_UNAVAILABLE: 'The item conversation could not be created yet. Resume retries.',
  BOT_IDENTITY_REQUIRED: 'A step needs a service identity the bot does not have. Add the connector in the bot settings, then Resume.',
  BOT_IDENTITY_UNAVAILABLE: 'The selected service identity could not be read. Reconnect it in the bot settings, then Resume.',
  BOT_PROJECT_ACCESS_REQUIRED: 'The bot has no access to this project. Give it access in the bot settings.',
  BOT_DAILY_TOKEN_BUDGET: 'The bot used its daily token budget. Raise the limit or wait for the next day, then Resume.',
  BOT_GOAL_TOKEN_BUDGET: 'This item used its token budget. Raise the limit in the bot settings, then Resume.',
  BOT_PENDING_HUMAN_LIMIT: 'Too many of this bot\'s items wait on people. Settle one of them first.',
  BOT_STOP_REQUESTED: 'The item is stopping as requested.',
  BOT_ARTIFACTS_MISSING: 'The work lacks an artifact the bot settings require. The bot must present it before judgment; Resume once it has.',
  BOT_PUBLICATION_BRANCH_REQUIRED: 'The project naming rules need a branch name proposal before the correction can start. Answer with a compliant name.',
  BOT_TOOL_OPERATION_PENDING: 'A write the bot started has not settled. Resume repairs or reconciles it.',
  BOT_OPERATION_FAILED: 'A step failed without a more specific reason. Resume retries it.',
  BOT_SESSION_ERROR: 'A bot session reported an error. Open it to read the cause, then Resume.',
  BOT_TOKEN_USAGE_UNAVAILABLE: 'The server could not read the session token usage, which the budgets need. Resume retries.',
  BOT_REMOTE_AUTHORIZATION_UNCONFIRMED: 'GitHub auto-merge may still be active and could not be confirmed off. Check the pull request.',
} as const;

const isExplained = (code: string): code is keyof typeof explanations => Object.hasOwn(explanations, code);
export const waitExplanation = (code: string) => isExplained(code) ? explanations[code] : 'No more detail is recorded for this reason; open the item record and the stage sessions for the cause.';
