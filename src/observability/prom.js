import client from "prom-client";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in ms",
  labelNames: ["method", "route", "status"],
  buckets: [5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000],
});
register.registerMetric(httpRequestDurationMs);

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP requests total",
  labelNames: ["method", "route", "status"],
});
register.registerMetric(httpRequestsTotal);

export const httpErrorsTotal = new client.Counter({
  name: "http_errors_total",
  help: "HTTP errors total (>=500)",
  labelNames: ["method", "route", "status"],
});
register.registerMetric(httpErrorsTotal);

export const jobsTotal = new client.Counter({
  name: "jobs_total",
  help: "Jobs processed total",
  labelNames: ["name", "status"], // status: success|failed|skipped
});
register.registerMetric(jobsTotal);

export const jobsQueueDepth = new client.Gauge({
  name: "jobs_queue_depth",
  help: "Current jobs pending count",
  labelNames: ["name"],
});
register.registerMetric(jobsQueueDepth);

export const dbQueryDurationMs = new client.Histogram({
  name: "db_query_duration_ms",
  help: "Database query duration in ms",
  labelNames: ["operation", "collection", "status"], // status: ok|error|timeout
  buckets: [5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000],
});
register.registerMetric(dbQueryDurationMs);

export const dbQueryTimeoutsTotal = new client.Counter({
  name: "db_query_timeouts_total",
  help: "Database query timeouts (maxTimeMS expired)",
  labelNames: ["operation", "collection"],
});
register.registerMetric(dbQueryTimeoutsTotal);

export const dbSlowQueriesTotal = new client.Counter({
  name: "db_slow_queries_total",
  help: "Database slow query count",
  labelNames: ["operation", "collection"],
});
register.registerMetric(dbSlowQueriesTotal);

export async function renderMetrics() {
  return register.metrics();
}

export { register };
