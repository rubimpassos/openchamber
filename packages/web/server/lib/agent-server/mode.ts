import net from 'node:net';

export type AgentServerEnvironment = Readonly<NodeJS.ProcessEnv>;

export type AgentUpstreamConfiguration = {
  readonly url: string;
  readonly token: string;
};

export type AgentServerMode =
  | { readonly frontDoor: false; readonly agent: boolean; readonly upstream: null }
  | { readonly frontDoor: true; readonly agent: false; readonly upstream: AgentUpstreamConfiguration };

export class AgentServerModeError extends Error {}

export function readAgentServerMode(env: AgentServerEnvironment = process.env): AgentServerMode {
  const raw = env.OPENCHAMBER_AGENT_SERVER_URL;
  const token = env.OPENCHAMBER_AGENT_SERVER_TOKEN;
  const agent = env.OPENCHAMBER_AGENT_SERVER === '1';
  if (!raw && !token) return { frontDoor: false, agent, upstream: null };
  if (!raw || !token?.trim()) throw new AgentServerModeError('Front door requires OPENCHAMBER_AGENT_SERVER_URL and OPENCHAMBER_AGENT_SERVER_TOKEN.');
  let url;
  try { url = new URL(raw); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new AgentServerModeError('OPENCHAMBER_AGENT_SERVER_URL must be a loopback HTTP origin.');
  }
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || (net.isIP(host) === 4 && host.startsWith('127.'));
  if (agent || url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AgentServerModeError('OPENCHAMBER_AGENT_SERVER_URL must be a loopback HTTP origin, without credentials, path, query or fragment; agent and front door modes are exclusive.');
  }
  if (host === 'localhost') url.hostname = '127.0.0.1';
  return { frontDoor: true, agent: false, upstream: { url: url.origin, token } };
}

export const FRONT_DOOR_DISABLED_RUNTIMES = Object.freeze([
  'managedOpenCode', 'sessionAssist', 'sessionGoal', 'contextObligatory', 'sessionWarming',
  'sessionKnowledge', 'sessionWork', 'sessionInterruption', 'autoResume', 'automationAdmission',
  'permissionAutoAccept', 'autoReview', 'messageQueue', 'prStackRestack',
  'dispatchResults', 'prWatch', 'mergeFollow', 'workflow', 'workflowAgentSessions',
  'messageSearch', 'scheduledTasks', 'scheduledTaskService', 'suggestedTasks', 'sessionTodos',
  'extensionWaits', 'laterPages', 'sharePages', 'receivedPages',
  'browserControlBroker', 'browserControlRouter', 'agentTool', 'limitFailover', 'routing',
  'managedConfig', 'guestServices', 'guestSurface', 'extensionSessionEvents', 'extensionServiceLifetime', 'memoryDreaming',
  'extensionNotificationChannels', 'trackerSessionStatus', 'turnDurationRecorder',
  'projectContext', 'agentMemory', 'projectConfig', 'environment', 'terminal', 'devTunnel',
] as const);

export const AGENT_DISABLED_FEATURES = Object.freeze([
  'pushDelivery', 'relayHost', 'tunnels', 'spaces', 'protectedMcpAdmin', 'updateInstall', 'botCoordinator',
] as const);

export function createAgentTunnelContext() {
  let port: number | null = null;
  return {
    getActivePort: () => port,
    setActivePort: (value: number | null) => { port = value; },
    tunnelService: { getPublicUrl: () => null },
    startTunnelWithNormalizedRequest: async () => { throw new AgentServerModeError('agent_feature_disabled'); },
  };
}
