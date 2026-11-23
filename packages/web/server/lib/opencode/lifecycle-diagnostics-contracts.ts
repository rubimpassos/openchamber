import type { CgroupMemory, RestartCause } from './cgroup-memory.js';

export interface ManagedOpenCodeProcessSnapshot {
  pid: number | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrTail: string;
}

export interface OpenCodeHealthFailure {
  class: string;
  detail: string;
}

export interface OpenCodeHealthResult {
  healthy: boolean;
  failure: OpenCodeHealthFailure | null;
}

export interface OpenCodeHealthProbeResult extends OpenCodeHealthResult {
  at: number;
}

export interface OpenCodeLaunchDiagnostics {
  launchedAt: string;
  sourceBinary: string;
  binary: string;
  args: string[];
  cwd: string;
  hostname: string;
  port: number;
  wrapperType: string | null;
  pathEntryCount: number;
  hasShellEnv: boolean;
  shellEnvKeysCount: number;
}

export interface OpenCodeHealthFailureSnapshot extends OpenCodeHealthFailure {
  at: string;
  source: string;
}

export interface OpenCodeRestartDiagnostics {
  reason: string;
  cause: RestartCause;
  memory: RestartMemory | null;
  healthFailure: OpenCodeHealthFailureSnapshot | null;
  process: (ManagedOpenCodeProcessSnapshot & { alive: boolean }) | null;
  busySessionCount: number;
  at: string;
}

export interface RestartMemory {
  readonly atFirstFailure: CgroupMemory | null;
  readonly atRestart: CgroupMemory | null;
}
