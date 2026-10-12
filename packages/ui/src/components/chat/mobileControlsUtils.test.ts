import { describe, expect, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import { getCycledPrimaryAgentName, getShortAgentLabel, getShortModelLabel } from './mobileControlsUtils';

const agent = (name: string, mode: Agent['mode'] = 'primary'): Pick<Agent, 'name' | 'mode'> => ({ name, mode });
const agents = [agent('build'), agent('plan'), agent('incident'), agent('review'), agent('helper', 'subagent')];

describe('getCycledPrimaryAgentName', () => {
  test('without favorites cycles through every primary agent as before', () => {
    expect(getCycledPrimaryAgentName(agents, 'build')).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'review')).toBe('build');
    expect(getCycledPrimaryAgentName(agents, 'build', -1)).toBe('review');
  });

  test('with favorites cycles through the favorites only', () => {
    const favorites = ['build', 'review'];
    expect(getCycledPrimaryAgentName(agents, 'build', 1, favorites)).toBe('review');
    expect(getCycledPrimaryAgentName(agents, 'review', 1, favorites)).toBe('build');
    expect(getCycledPrimaryAgentName(agents, 'review', -1, favorites)).toBe('build');
  });

  test('enters the favorites from an agent outside them', () => {
    expect(getCycledPrimaryAgentName(agents, 'incident', 1, ['plan', 'review'])).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'incident', -1, ['plan', 'review'])).toBe('review');
  });

  test('a single favorite is a fixed point, and unavailable favorites are ignored', () => {
    expect(getCycledPrimaryAgentName(agents, 'plan', 1, ['plan'])).toBeNull();
    expect(getCycledPrimaryAgentName(agents, 'build', 1, ['plan'])).toBe('plan');
    expect(getCycledPrimaryAgentName(agents, 'build', 1, ['gone', 'helper'])).toBe('plan');
  });
});

describe('getShortModelLabel', () => {
  test('drops the family word before a named tier', () => {
    expect(getShortModelLabel('Claude Opus 5.5')).toBe('Opus 5.5');
    expect(getShortModelLabel('Claude Sonnet 4')).toBe('Sonnet 4');
  });

  test('keeps names whose next word is a version, short names and hyphenated families', () => {
    expect(getShortModelLabel('Gemini 2.5 Pro')).toBe('Gemini 2.5 Pro');
    expect(getShortModelLabel('Sol 6.1')).toBe('Sol 6.1');
    expect(getShortModelLabel('GPT-5 mini high')).toBe('GPT-5 mini high');
  });
});

describe('getShortAgentLabel', () => {
  test('keeps the part before " - "', () => {
    expect(getShortAgentLabel('Sisyphus - ultraworker')).toBe('Sisyphus');
    expect(getShortAgentLabel('Build')).toBe('Build');
    expect(getShortAgentLabel('Code-reviewer')).toBe('Code-reviewer');
  });
});
