// src/routes/health.routes.js
import express from "express";
import mongoose from "mongoose";
import { getRequestId } from "../middleware/error.js";
import { getDbHealth } from "../config/db.js";

const router = express.Router();
const WEB_VITALS_WINDOW_MS = 60 * 60 * 1000; // 1h rolling window
const WEB_VITALS_MAX_EVENTS = 5000;
const METRIC_NAMES = new Set(["CLS", "LCP", "INP", "FCP", "TTFB"]);
const webVitalsBuffer = [];

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pruneWebVitals(nowTs = Date.now()) {
  const cutoff = nowTs - WEB_VITALS_WINDOW_MS;
  while (webVitalsBuffer.length && webVitalsBuffer[0].ts < cutoff) {
    webVitalsBuffer.shift();
  }
  while (webVitalsBuffer.length > WEB_VITALS_MAX_EVENTS) {
    webVitalsBuffer.shift();
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  );
  return sorted[idx];
}

function evaluateRating(name, value) {
  // Web Vitals guidance thresholds (LCP/CLS/INP) + practical guidance for FCP/TTFB.
  if (name === "LCP")
    return value <= 2500
      ? "good"
      : value <= 4000
        ? "needs-improvement"
        : "poor";
  if (name === "CLS")
    return value <= 0.1 ? "good" : value <= 0.25 ? "needs-improvement" : "poor";
  if (name === "INP")
    return value <= 200 ? "good" : value <= 500 ? "needs-improvement" : "poor";
  if (name === "FCP")
    return value <= 1800
      ? "good"
      : value <= 3000
        ? "needs-improvement"
        : "poor";
  if (name === "TTFB")
    return value <= 800 ? "good" : value <= 1800 ? "needs-improvement" : "poor";
  return "unknown";
}

function errorPayload(req, code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

function requiredEnvMissing() {
  const missing = [];
  if (!process.env.MONGO_URI) missing.push("MONGO_URI");
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  return missing;
}

function isMongooseConnected() {
  return mongoose.connection?.readyState === 1;
}

/**
 * GET /api/health (root)
 * Simple health check - always returns 200 if the server is running.
 * Use /health/ready for full readiness check including DB.
 */
router.get("/", (_req, res) => {
  return res.json({ ok: true, success: true, data: { status: "healthy" } });
});

router.get("/live", (_req, res) => {
  return res.json({ ok: true, data: {} });
});

/**
 * ✅ DELIVERABLE #1: Readiness endpoint includes DB health + transaction support
 * Returns NOT READY if:
 * - Database not connected
 * - Required env vars missing
 * - Transactions required but not supported
 */
router.get("/ready", (req, res) => {
  const missing = requiredEnvMissing();
  if (!isMongooseConnected()) {
    return res
      .status(503)
      .json(errorPayload(req, "DB_NOT_READY", "Database not connected"));
  }
  if (missing.length) {
    return res
      .status(503)
      .json(
        errorPayload(req, "ENV_MISSING", `Missing env: ${missing.join(",")}`),
      );
  }

  // ✅ Check DB health including transaction support
  const dbHealth = getDbHealth();
  if (!dbHealth.healthy) {
    return res
      .status(503)
      .json(
        errorPayload(
          req,
          "DB_NOT_HEALTHY",
          dbHealth.transactionsRequired && !dbHealth.transactionsSupported
            ? "Transactions required but not supported. Use a MongoDB replica set."
            : "Database health check failed",
        ),
      );
  }

  return res.json({
    ok: true,
    data: {
      dbConnected: dbHealth.connected,
      transactionsSupported: dbHealth.transactionsSupported,
      transactionsRequired: dbHealth.transactionsRequired,
    },
  });
});

/**
 * POST /api/v1/health/web-vitals
 * Receives client-side web-vitals metrics via sendBeacon/fetch.
 */
router.post("/web-vitals", (req, res) => {
  const metric = req.body?.metric || {};
  const name = String(metric?.name || "").toUpperCase();
  const value = toFiniteNumber(metric?.value, NaN);
  const ts = toFiniteNumber(req.body?.ts, Date.now());

  if (!METRIC_NAMES.has(name) || !Number.isFinite(value)) {
    return res
      .status(400)
      .json(errorPayload(req, "BAD_REQUEST", "Invalid web vitals payload"));
  }

  const event = {
    name,
    value,
    delta: toFiniteNumber(metric?.delta, 0),
    rating:
      typeof metric?.rating === "string"
        ? metric.rating
        : evaluateRating(name, value),
    path: String(req.body?.path || "").slice(0, 300),
    ua: String(req.body?.ua || "").slice(0, 500),
    sessionId: String(req.body?.sessionId || "").slice(0, 128),
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };

  webVitalsBuffer.push(event);
  pruneWebVitals(Date.now());

  return res.status(202).json({ ok: true, data: { accepted: true } });
});

/**
 * GET /api/v1/health/web-vitals/summary
 * Rolling 1h summary (counts + p75 + average) for launch baseline checks.
 */
router.get("/web-vitals/summary", (_req, res) => {
  pruneWebVitals(Date.now());
  const byMetric = {};

  for (const metricName of METRIC_NAMES) {
    const values = webVitalsBuffer
      .filter((row) => row.name === metricName)
      .map((row) => row.value)
      .sort((a, b) => a - b);

    const count = values.length;
    const avg = count ? values.reduce((sum, n) => sum + n, 0) / count : null;
    const p75 = quantile(values, 0.75);
    const rating = p75 == null ? "unknown" : evaluateRating(metricName, p75);

    byMetric[metricName] = {
      count,
      avg,
      p75,
      rating,
    };
  }

  return res.json({
    ok: true,
    data: {
      windowMs: WEB_VITALS_WINDOW_MS,
      sampleSize: webVitalsBuffer.length,
      metrics: byMetric,
      thresholds: {
        CLS: { good: "<=0.1", needsImprovement: "<=0.25" },
        LCP: { good: "<=2500ms", needsImprovement: "<=4000ms" },
        INP: { good: "<=200ms", needsImprovement: "<=500ms" },
        FCP: { good: "<=1800ms", needsImprovement: "<=3000ms" },
        TTFB: { good: "<=800ms", needsImprovement: "<=1800ms" },
      },
    },
  });
});

export default router;
