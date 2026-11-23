import path from 'node:path';

export const SERVICE_USER = 'openchamber-mcp';
export const CLIENT_GROUP = 'openchamber-mcp-clients';
export const ADMIN_GROUP = 'openchamber-mcp-admins';
export const UNIT_NAME = 'openchamber-protected-mcp.service';
export const SUBJECT_BIND_PATH = '/run/openchamber-mcp';

export function layout(root = '/') {
  const at = (target: string): string => path.join(root, target);
  return {
    installDir: at('/usr/lib/openchamber-protected-mcp'),
    configDir: at('/etc/openchamber/protected-mcp'),
    serviceConfig: at('/etc/openchamber/protected-mcp/service.json'),
    clientConfig: at('/etc/openchamber/protected-mcp/client.json'),
    agentClientConfig: at('/etc/openchamber/protected-mcp/agent-client.json'),
    stateDir: at('/var/lib/openchamber-protected-mcp'),
    engineSocket: at('/run/openchamber-protected-mcp/engine.sock'),
    unitFile: at(`/etc/systemd/system/${UNIT_NAME}`),
    tmpfilesFile: at('/etc/tmpfiles.d/openchamber-protected-mcp.conf'),
    live: {
      installDir: '/usr/lib/openchamber-protected-mcp',
      configDir: '/etc/openchamber/protected-mcp',
      stateDir: '/var/lib/openchamber-protected-mcp',
      engineSocket: '/run/openchamber-protected-mcp/engine.sock',
      subjectsDir: '/run/openchamber-protected-mcp/subjects',
      adminSocket: '/run/openchamber-protected-mcp-admin/admin.sock',
      serviceConfig: '/etc/openchamber/protected-mcp/service.json',
      agentClientConfig: '/etc/openchamber/protected-mcp/agent-client.json',
    },
  };
}

export function tmpfilesFile({ subjectsDir }: { readonly subjectsDir: string }): string {
  return [
    `d ${path.dirname(subjectsDir)} 0750 ${SERVICE_USER} ${SERVICE_USER} -`,
    `d ${subjectsDir} 0700 ${SERVICE_USER} ${SERVICE_USER} -`,
    `d ${subjectsDir}/agent 0711 ${SERVICE_USER} ${SERVICE_USER} -`,
    '',
  ].join('\n');
}

export function unitFile({ node, live }: { readonly node: string; readonly live: Pick<ReturnType<typeof layout>['live'], 'installDir' | 'serviceConfig' | 'stateDir'> }): string {
  return `[Unit]
Description=OpenChamber protected MCP service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
SupplementaryGroups=${CLIENT_GROUP} ${ADMIN_GROUP}
ExecStart=${node} ${live.installDir}/current/lib/protected-mcp/service/main.js --config ${live.serviceConfig}
WorkingDirectory=${live.stateDir}
StateDirectory=openchamber-protected-mcp
StateDirectoryMode=0700
RuntimeDirectory=openchamber-protected-mcp openchamber-protected-mcp-admin
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LimitCORE=0
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}
