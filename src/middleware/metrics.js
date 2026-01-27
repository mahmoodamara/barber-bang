// src/middleware/metrics.js

const metrics = {
  startedAt: Date.now(),
  requestCount: 0,
  totalLatencyMs: 0,
};

export function metricsMiddleware() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.once("finish", () => {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;
      metrics.requestCount += 1;
      metrics.totalLatencyMs += ms;
    });
    next();
  };
}

export function getMetricsSnapshot() {
  const avgLatencyMs =
    metrics.requestCount > 0 ? metrics.totalLatencyMs / metrics.requestCount : 0;
  return {
    ok: true,
    startedAt: new Date(metrics.startedAt).toISOString(),
    requestCount: metrics.requestCount,
    avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
  };
}
