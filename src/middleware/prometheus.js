// src/middleware/prometheus.js

import { Registry, Counter, Histogram } from "prom-client";
import { normalizePath } from "../utils/path.js";

const register = new Registry();

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const webhookEventsTotal = new Counter({
  name: "webhook_events_total",
  help: "Total webhook events (Stripe)",
  labelNames: ["type", "status"],
  registers: [register],
});

const checkoutFailuresTotal = new Counter({
  name: "checkout_failures_total",
  help: "Total checkout failures by error code",
  labelNames: ["code"],
  registers: [register],
});

const refundOperationsTotal = new Counter({
  name: "refund_operations_total",
  help: "Total refund operations by type and status",
  labelNames: ["type", "status"],
  registers: [register],
});

const invoiceRetryAttemptTotal = new Counter({
  name: "invoice_retry_attempt_total",
  help: "Total invoice retry attempts",
  registers: [register],
});
const invoiceRetrySuccessTotal = new Counter({
  name: "invoice_retry_success_total",
  help: "Total invoice retries that succeeded",
  registers: [register],
});
const invoiceRetryFailedTotal = new Counter({
  name: "invoice_retry_failed_total",
  help: "Total invoice retries that failed",
  registers: [register],
});

const invoiceIssueTotal = new Counter({
  name: "invoice_issue_total",
  help: "Total invoice issuance attempts",
  labelNames: ["status", "source"],
  registers: [register],
});

const dbQueryDurationSeconds = new Histogram({
  name: "db_query_duration_seconds",
  help: "Database query duration in seconds",
  labelNames: ["operation"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

/**
 * Normalize route for metrics (stable label, no IDs).
 * Base path from canonical req.originalUrl; replaces MongoDB ObjectIds with :id for cardinality.
 */
function normalizeRoute(req) {
  const path = normalizePath(req.originalUrl);
  if (!path) return "unknown";
  // Replace 24-char hex ObjectIds with :id for cardinality control
  const normalized = path
    .replace(/\/[0-9a-fA-F]{24}\b/g, "/:id")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
  return normalized;
}

/**
 * Prometheus middleware: record start time, set req.metricsRoute, on finish increment counter and observe duration.
 */
export function getPrometheusMiddleware() {
  return (req, res, next) => {
    req.metricsRoute = normalizeRoute(req);
    const start = process.hrtime.bigint();

    res.once("finish", () => {
      const status = String(res.statusCode || 500);
      const method = (req.method || "GET").toUpperCase();
      const route = req.metricsRoute || "unknown";

      httpRequestsTotal.inc({ method, route, status });

      const end = process.hrtime.bigint();
      const durationSeconds = Number(end - start) / 1e9;
      httpRequestDurationSeconds.observe({ route }, durationSeconds);
    });

    next();
  };
}

export function getWebhookEventCounter() {
  return webhookEventsTotal;
}

export function getCheckoutFailureCounter() {
  return checkoutFailuresTotal;
}

export function getRefundOperationsCounter() {
  return refundOperationsTotal;
}

export function getInvoiceRetryCounters() {
  return {
    attempt: () => invoiceRetryAttemptTotal.inc(),
    success: () => invoiceRetrySuccessTotal.inc(),
    failed: () => invoiceRetryFailedTotal.inc(),
  };
}

export function getInvoiceIssueCounter() {
  return invoiceIssueTotal;
}

export function getDbDurationHistogram() {
  return dbQueryDurationSeconds;
}

/**
 * Returns Prometheus text format (for GET /metrics).
 */
export async function getMetricsContent() {
  return register.metrics();
}

export { register };
