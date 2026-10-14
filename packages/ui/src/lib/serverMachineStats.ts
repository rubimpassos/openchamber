import { z } from 'zod';

// Response of the server's authenticated GET /api/system/stats.
export const serverMachineSampleSchema = z.object({
  collectedAt: z.string(),
  hostname: z.string(),
  osName: z.string(),
  platform: z.string(),
  arch: z.string(),
  uptimeSec: z.number(),
  openchamberVersion: z.string(),
  openCodeRunning: z.boolean(),
  cpu: z.object({
    usagePercent: z.number().nullable(),
    cores: z.number(),
    model: z.string().nullable(),
    loadAverage: z.array(z.number()).nullable(),
  }),
  memory: z.object({
    totalBytes: z.number(),
    availableBytes: z.number(),
    usedPercent: z.number(),
  }),
  disk: z.object({
    path: z.string(),
    totalBytes: z.number(),
    availableBytes: z.number(),
    usedPercent: z.number(),
  }).nullable(),
  process: z.object({
    rssBytes: z.number(),
    cpuPercent: z.number().nullable(),
    uptimeSec: z.number(),
  }),
});

export type ServerMachineSample = z.infer<typeof serverMachineSampleSchema>;

export const parseServerMachineSample = (payload: z.input<typeof serverMachineSampleSchema>): ServerMachineSample | null => {
  const parsed = serverMachineSampleSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

export type MachineLevel = 'ok' | 'warning' | 'critical';
export type MachineResource = 'cpu' | 'memory' | 'disk';

// Percent thresholds (warning, critical). Coder alerts on memory at 90% and
// disks at 80–95%; CPU only matters when it stays pegged, so it sits higher.
const THRESHOLDS = {
  cpu: [80, 95],
  memory: [85, 95],
  disk: [85, 95],
} as const satisfies Record<MachineResource, readonly [number, number]>;

export const machineLevel = (resource: MachineResource, percent: number | null): MachineLevel => {
  if (percent === null) return 'ok';
  const [warning, critical] = THRESHOLDS[resource];
  if (percent >= critical) return 'critical';
  if (percent >= warning) return 'warning';
  return 'ok';
};

type MachinePressure = { resource: MachineResource; level: Exclude<MachineLevel, 'ok'>; percent: number };

// The single resource worth surfacing outside the panel: the most severe one,
// with disk first among equals because a full disk breaks the most things.
export const worstMachinePressure = (sample: ServerMachineSample): MachinePressure | null => {
  const candidates: Array<{ resource: MachineResource; percent: number | null }> = [
    { resource: 'disk', percent: sample.disk?.usedPercent ?? null },
    { resource: 'memory', percent: sample.memory.usedPercent },
    { resource: 'cpu', percent: sample.cpu.usagePercent },
  ];
  let worst: MachinePressure | null = null;
  for (const { resource, percent } of candidates) {
    const level = machineLevel(resource, percent);
    if (level === 'ok' || percent === null) continue;
    if (!worst || (level === 'critical' && worst.level === 'warning')) {
      worst = { resource, level, percent };
    }
  }
  return worst;
};
