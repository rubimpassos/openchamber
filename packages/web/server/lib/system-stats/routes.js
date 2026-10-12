// Registered after the /api auth gate: hostname, uptime and resource usage are
// not for anyone who can merely reach the server (unlike the public /health).
export function registerSystemStatsRoutes(app, { collector, openchamberVersion, isOpenCodeRunning }) {
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
