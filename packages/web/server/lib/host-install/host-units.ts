export const APP_UNIT = 'openchamber.service';
export const AGENT_UNIT = 'openchamber-agent.service';
export const HOSTD_SOCKET = 'openchamber-hostd.socket';
export const HOSTD_UNIT = 'openchamber-hostd.service';
export const UPDATER_UNIT = 'openchamber-updater.service';
export const UPDATER_TIMER = 'openchamber-updater.timer';
export const UPDATER_PATH = 'openchamber-updater.path';
export const MANAGED_MARKER = '# Managed by the OpenChamber host installer.';
export const ALL_UNITS = [APP_UNIT, AGENT_UNIT, HOSTD_SOCKET, HOSTD_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH] as const;
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
export const ownerPath = (owner: Pick<UnitAccount, 'home'>): readonly string[] => [`${owner.home}/.local/bin`, `${owner.home}/.opencode/bin`, `${owner.home}/.bun/bin`, ...SYSTEM_PATH.split(':')];
const quote = (value: string) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function appUnit({ config, owner, front = null, toolchain, live }: UnitRuntime & {
  readonly config: UnitConfig;
  readonly owner: UnitAccount;
  readonly front?: Pick<UnitAccount, 'uid'> | null;
}): string {
  const separated = config.separation;
  const name = separated ? separated.frontDoor : owner.name;
  const home = separated ? '/var/lib/openchamber' : owner.home;
  const docker = separated && separated.frontDocker && front ? `Environment=DOCKER_HOST=unix:///run/user/${front.uid}/docker.sock\n` : '';
  return `${MANAGED_MARKER}
# Add settings in /etc/systemd/system/${APP_UNIT}.d/*.conf; this file is rewritten on every update.
[Unit]
Description=OpenChamber
After=network-online.target${separated ? ` ${AGENT_UNIT} ${HOSTD_SOCKET}` : ''}
Wants=network-online.target ${HOSTD_SOCKET}${separated ? ` ${AGENT_UNIT}` : ''}

[Service]
Type=simple
User=${name}
Group=${separated ? name : owner.gid}
WorkingDirectory=${home}
Environment=HOME=${home}
Environment=${quote(`PATH=${separated ? SYSTEM_PATH : ownerPath(owner).join(':')}`)}
Environment=OPENCHAMBER_UPDATE_REPO=${config.repo}
EnvironmentFile=-${live.envFile}
${separated ? 'EnvironmentFile=/etc/openchamber/agent-link.env\nProtectHome=tmpfs\nPrivateTmp=yes\n' : ''}${docker}ExecStart=${toolchain.node} ${live.app}/build/bin/cli.js serve --foreground --port ${config.port} --host ${quote(config.host)}
Restart=always
RestartSec=5
SuccessExitStatus=143
NoNewPrivileges=yes
ProtectSystem=full
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

export function agentUnit({ config, agent, toolchain, live }: UnitRuntime & {
  readonly config: { readonly separation: Separation; readonly ownerUid: number };
  readonly agent: UnitAccount;
}): string {
  return `${MANAGED_MARKER}
[Unit]
Description=OpenChamber agent
After=network-online.target openchamber-protected-mcp.service
Wants=network-online.target openchamber-protected-mcp.service

[Service]
Type=simple
User=${agent.name}
Group=${agent.gid}
WorkingDirectory=${agent.home}
Environment=HOME=${agent.home}
Environment=${quote(`PATH=${ownerPath(agent).join(':')}`)}
EnvironmentFile=/etc/openchamber/agent.env
Environment=OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG=/etc/openchamber/protected-mcp/agent-client.json
${config.separation.docker ? `Environment=DOCKER_HOST=unix:///run/user/${agent.uid}/docker.sock\n` : ''}BindReadOnlyPaths=-/run/openchamber-protected-mcp/subjects/agent:/run/openchamber-mcp
InaccessiblePaths=-/run/openchamber-hostd -/run/openchamber-protected-mcp-admin -/var/lib/openchamber -/etc/openchamber/openchamber.env -/etc/openchamber/agent-link.env -/run/user/${config.ownerUid}
ProtectProc=invisible
PrivateTmp=yes
NoNewPrivileges=yes
UMask=0077
Restart=always
RestartSec=5
ExecStart=${toolchain.node} ${live.app}/build/bin/cli.js serve --foreground --api-only --host 127.0.0.1 --port ${config.separation.agentPort}

[Install]
WantedBy=multi-user.target
`;
}

export function hostdUnits({ config, toolchain, live }: UnitRuntime & { readonly config: Pick<UnitConfig, 'owner' | 'separation'> }) {
  return {
    [HOSTD_SOCKET]: `${MANAGED_MARKER}
[Unit]
Description=OpenChamber root operations socket

[Socket]
ListenStream=/run/openchamber-hostd/hostd.sock
SocketUser=${config.separation?.frontDoor ?? config.owner}
SocketGroup=root
SocketMode=0600
DirectoryMode=0711
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
`,
    [HOSTD_UNIT]: `${MANAGED_MARKER}
[Unit]
Description=OpenChamber root operations
Requires=${HOSTD_SOCKET}
After=${HOSTD_SOCKET}

[Service]
ExecStart=${toolchain.node} ${live.app}/build/server/lib/hostd/main.js
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
Restart=on-failure
# No PrivateTmp or Protect* option here: each gives hostd a mount namespace of its own, and the
# namespace pins it bind-mounts for the space's network must be visible to the units it starts.
# No User= either, not even root: with LockPersonality, systemd 259 then starts hostd without
# CAP_SETUID, and every space's network holder fails with "setresuid failed".
`,
  };
}

export function updaterUnits({ toolchain, live }: UnitRuntime) {
  return {
    [UPDATER_UNIT]: `${MANAGED_MARKER}
[Unit]
Description=OpenChamber host updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${toolchain.node} ${live.app}/build/server/lib/host-install/main.js update
NoNewPrivileges=yes
PrivateTmp=yes
`,
    [UPDATER_TIMER]: `${MANAGED_MARKER}
[Unit]
Description=Check for OpenChamber updates daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
    [UPDATER_PATH]: `${MANAGED_MARKER}
[Unit]
Description=Run the OpenChamber updater when OpenChamber asks for an update

[Path]
PathChanged=${live.requestFile}
Unit=${UPDATER_UNIT}

[Install]
WantedBy=paths.target
`,
  };
}
import type { HostPaths, HostToolchain } from './host-paths.js';

type UnitAccount = { readonly name: string; readonly home: string; readonly uid: number; readonly gid: number };
type Separation = {
  readonly frontDoor: string;
  readonly agent: string;
  readonly agentPort: number;
  readonly docker?: boolean;
  readonly frontDocker?: boolean;
};
type UnitConfig = {
  readonly owner: string;
  readonly repo: string;
  readonly port: number;
  readonly host: string;
  readonly separation?: Separation | null;
};
type UnitRuntime = { readonly toolchain: Pick<HostToolchain, 'node'>; readonly live: HostPaths };
