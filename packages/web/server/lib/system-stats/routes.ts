import type { Application } from '../shared/http-contracts.js';
import type { createSystemStatsCollector } from './collect.js';

export function registerSystemStatsRoutes(app: Pick<Application, 'get'>, { collector, openchamberVersion, isOpenCodeRunning }: {
  readonly collector: ReturnType<typeof createSystemStatsCollector>;
  readonly openchamberVersion: string;
  readonly isOpenCodeRunning: () => boolean;
}) {
  app.get('/api/system/stats', async (_req, res) => {
    try {
      const stats = await collector.collect();
      res.set('Cache-Control', 'no-store');
      res.json({
        ...stats,
        openchamberVersion,
        openCodeRunning: isOpenCodeRunning(),
      });
    } catch (error) {
      console.error('Failed to collect system stats:', error);
      res.status(500).json({ error: 'Failed to collect system stats' });
    }
  });
}
