// src/api/app.js — Hardened (Phase 5+) + proxy-safe IP + webhook-safe pipeline + admin no-store + consistent health envelopes
import express from "express";
import pinoHttp from "pino-http";

import { APP } from "../constants/app.js";
import { ENV } from "../utils/env.js";
import { logger } from "../utils/logger.js";

import { requestId } from "../middlewares/requestId.js";
import { queryBudget } from "../middlewares/queryBudget.js";
import { helmetMiddleware } from "../middlewares/helmet.js";
import { corsMiddleware } from "../middlewares/cors.js";
import { globalLimiter } from "../middlewares/rateLimiters.js";
import { compressionMiddleware } from "../middlewares/compression.js";
import { idempotency } from "../middlewares/idempotency.js";
import { slowRequestLog } from "../middlewares/slowRequestLog.js";
import { serviceDegraded } from "../middlewares/serviceDegraded.js";
import { hppMiddleware } from "../middlewares/hpp.js";
import { mongoSanitizeMiddleware } from "../middlewares/mongoSanitize.js";
import { notFound } from "../middlewares/notFound.js";
import { errorHandler } from "../middlewares/errorHandler.js";
import { responseEnvelope } from "../middlewares/responseEnvelope.js";
import { langMiddleware } from "../middlewares/lang.js";
import { isDbReady } from "../data/db.js";

import { apiRouter } from "./routes/index.js";

// Webhooks router (route itself defines /stripe)
import webhooksRoutes from "./routes/webhooks.routes.js";

// Metrics
import { metricsMiddleware } from "../middlewares/metrics.js";
import { requireMetricsAuth } from "../middlewares/requireMetricsAuth.js";
import { renderMetrics } from "../observability/prom.js";

const WEBHOOK_PREFIX = "/api/v1/webhooks";

function isWebhook(req) {
  // includes querystring - still fine for prefix match
  return req.originalUrl?.startsWith(WEBHOOK_PREFIX);
}

function isMethodWithoutBody(req) {
  return req.method === "GET" || req.method === "HEAD";
}

/**
 * trust proxy parsing:
 * - "1" => 1 hop
 * - "true" => 1 hop (safe default; avoid trust all)
 * - "false" => no proxy trust
 * - allow express patterns: "loopback", "uniquelocal", CIDR, etc.
 */
function parseTrustProxy(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;

  const v = String(value).trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;

  // SAFE: treat true/yes/1 as 1 hop (avoid spoofable trust-all)
  if (v === "true" || v === "1" || v === "yes") return 1;

  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;

  // allow express trust proxy patterns / CIDR strings
  return value;
}

// lightweight consistent envelopes for non-/api/v1 endpoints (health, metrics)
function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function fail(res, { statusCode = 500, code = "ERROR", message = "Error", requestId, details } = {}) {
  return res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
      requestId: requestId || null,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");

  // Prefer JSON types; keep BODY_LIMIT from env
  const jsonParser = express.json({
    limit: ENV.BODY_LIMIT,
    type: ["application/json", "application/*+json"],
  });

  const urlencodedParser = express.urlencoded({
    extended: true,
    limit: ENV.BODY_LIMIT,
  });

  /* ------------------------------------------------------------------ */
  /* Proxy-safe IP                                                      */
  /* ------------------------------------------------------------------ */
  const trustProxyFallback = ENV.NODE_ENV === "production" ? 1 : false;
  const trustProxy = parseTrustProxy(ENV.TRUST_PROXY, trustProxyFallback);
  app.set("trust proxy", trustProxy);

  /* ------------------------------------------------------------------ */
  /* Core context + logging                                              */
  /* ------------------------------------------------------------------ */
  app.use(requestId);
  app.use(queryBudget);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.requestId,
      customProps: (req) => ({ requestId: req.requestId }),
    }),
  );

  // Slow request log should see the whole pipeline
  app.use(slowRequestLog);

  /* ------------------------------------------------------------------ */
  /* 🔴 Stripe Webhooks: mount EARLY                                     */
  /* - MUST be before body parsers/sanitizers                            */
  /* - Keep it minimal: no global limiter / compression / sanitize       */
  /* - Route will use express.raw for signature verification             */
  /* ------------------------------------------------------------------ */
  app.use(WEBHOOK_PREFIX, webhooksRoutes);

  /* ------------------------------------------------------------------ */
  /* Security headers + CORS (skip webhooks)                             */
  /* ------------------------------------------------------------------ */
  const cors = corsMiddleware();

  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return helmetMiddleware(req, res, next);
  });

  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return cors(req, res, next);
  });

  /* ------------------------------------------------------------------ */
  /* Phase 5: Metrics                                                   */
  /* - /metrics is protected by token if configured                      */
  /* - measure everything except webhooks + /metrics itself              */
  /* - infra paths should bypass global limiter + degraded gate          */
  /* ------------------------------------------------------------------ */
  const metricsEnabled = String(ENV.METRICS_ENABLED || "false") === "true";
  const metricsPath = String(ENV.METRICS_PATH || "/metrics");

  const infraPaths = new Set(["/health", "/health/ready", metricsPath]);

  if (metricsEnabled) {
    app.get(metricsPath, requireMetricsAuth, async (_req, res, next) => {
      try {
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(await renderMetrics());
      } catch (e) {
        next(e);
      }
    });

    app.use((req, res, next) => {
      if (isWebhook(req)) return next();
      if (req.path === metricsPath) return next();
      return metricsMiddleware(req, res, next);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Global protections (skip webhooks + infra routes)                   */
  /* ------------------------------------------------------------------ */
  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    if (infraPaths.has(req.path)) return next();
    return globalLimiter(req, res, next);
  });

  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return compressionMiddleware(req, res, next);
  });

  // IMPORTANT: allow infra routes even when degraded
  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    if (infraPaths.has(req.path)) return next();
    return serviceDegraded(req, res, next);
  });

  // Idempotency header capture (safe after webhooks)
  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return idempotency(req, res, next);
  });

  /* ------------------------------------------------------------------ */
  /* Body parsing (skip GET/HEAD + webhooks)                             */
  /* ------------------------------------------------------------------ */
  app.use((req, res, next) => {
    if (isWebhook(req) || isMethodWithoutBody(req)) return next();
    return jsonParser(req, res, next);
  });

  app.use((req, res, next) => {
    if (isWebhook(req) || isMethodWithoutBody(req)) return next();
    return urlencodedParser(req, res, next);
  });

  /* ------------------------------------------------------------------ */
  /* Input hardening (skip webhooks)                                     */
  /* ------------------------------------------------------------------ */
  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return hppMiddleware(req, res, next);
  });

  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return mongoSanitizeMiddleware(req, res, next);
  });

  /* ------------------------------------------------------------------ */
  /* Health checks (outside /api/v1 envelope)                            */
  /* ------------------------------------------------------------------ */
  app.get("/health", (req, res) => {
    return ok(res, {
      service: APP.name,
      version: APP.version,
      env: ENV.NODE_ENV,
      requestId: req.requestId,
      time: new Date().toISOString(),
    });
  });

  app.get("/health/ready", (req, res) => {
    if (!isDbReady()) {
      return fail(res, {
        statusCode: 503,
        code: "NOT_READY",
        message: "DB not connected",
        requestId: req.requestId,
      });
    }
    return ok(res, { requestId: req.requestId });
  });

  /* ------------------------------------------------------------------ */
  /* API v1                                                             */
  /* ------------------------------------------------------------------ */
  // Apply envelope only to API (skip webhooks)
  app.use((req, res, next) => {
    if (isWebhook(req)) return next();
    return responseEnvelope(req, res, next);
  });

  // Admin responses should never be cached (defense-in-depth)
  app.use("/api/v1/admin", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api/v1", langMiddleware, apiRouter);

  /* ------------------------------------------------------------------ */
  /* Errors                                                             */
  /* ------------------------------------------------------------------ */
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
