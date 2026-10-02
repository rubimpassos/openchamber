import { describe, expect, test } from 'bun:test';

import { sessionAgentLabel, splitSubagentTitle } from './subagentTitle';

describe('splitSubagentTitle', () => {
  test('moves the agent of a subagent title into a label', () => {
    expect(splitSubagentTitle('Find the auth middleware (@explore subagent)')).toEqual({ title: 'Find the auth middleware', agent: 'explore' });
    expect(splitSubagentTitle('Run tests (@Sisyphus-Junior subagent)')).toEqual({ title: 'Run tests', agent: 'Sisyphus-Junior' });
  });

  test('leaves other titles alone', () => {
    expect(splitSubagentTitle('Fix the (@login) form')).toEqual({ title: 'Fix the (@login) form', agent: null });
    expect(splitSubagentTitle('(@explore subagent)')).toEqual({ title: '(@explore subagent)', agent: null });
  });

  test('labels a native child session with its own agent, never a top-level one', () => {
    expect(sessionAgentLabel({ title: 'Check CI', parentID: 'ses_1', agent: 'general' })).toEqual({ title: 'Check CI', agent: 'general' });
    expect(sessionAgentLabel({ title: 'Check CI', parentID: null, agent: 'build' })).toEqual({ title: 'Check CI', agent: null });
  });
});
