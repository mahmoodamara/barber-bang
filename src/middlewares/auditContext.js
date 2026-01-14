// src/middlewares/auditContext.js
/**
 * Audit Context Middleware
 *
 * Attaches audit context to requests and provides helpers for logging.
 * Computes duration on response finish and flushes queued audit logs.
 */

import { logAudit } from "../services/audit.service.js";

// Paths to skip audit logging (high-frequency, low-value)
const SKIP_PATHS = new Set([
  "/health",
  "/health/ready",
  "/metrics",
  "/favicon.ico",
  "/robots.txt",
]);

// Path prefixes to skip
const SKIP_PREFIXES = ["/static", "/assets", "/public"];

/**
 * Check if request should be skipped for audit
 */
function shouldSkipAudit(req) {
  const path = req.path || req.url || "";

  // Skip exact matches
  if (SKIP_PATHS.has(path)) return true;

  // Skip prefix matches
  for (const prefix of SKIP_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Extract language from request
 */
function extractLang(req) {
  const reqLang = req?.lang;
  if (reqLang === "he" || reqLang === "ar") return reqLang;
  const lang = req.query?.lang || req.body?.lang || req.headers["accept-language"];
  if (lang === "he" || lang === "ar") return lang;
  if (typeof lang === "string") {
    if (lang.includes("he")) return "he";
    if (lang.includes("ar")) return "ar";
  }
  return null;
}

/**
 * Main audit context middleware
 */
export function auditContext(req, res, next) {
  // Skip paths that don't need audit context
  if (shouldSkipAudit(req)) {
    return next();
  }

  const startedAt = Date.now();

  // Build audit context
  req.auditCtx = {
    requestId: req.requestId || null,
    startedAt,
    ip: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get("user-agent") || null,
    lang: extractLang(req),
    idempotencyKey: req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || null,
    method: req.method,
    path: req.originalUrl || req.url,

    // Queue for batched writes (optional optimization)
    _queue: [],
    _flushed: false,
  };

  /**
   * Helper to queue an audit log entry
   * Will be written on response finish or can be called directly
   */
  req.audit = function auditHelper(entry) {
    if (req.auditCtx._flushed) {
      // Already flushed, write immediately (best-effort)
      logAudit(req, entry).catch(() => {});
      return;
    }
    req.auditCtx._queue.push(entry);
  };

  // On response finish, compute duration and flush queued logs
  res.on("finish", () => {
    if (req.auditCtx._flushed) return;
    req.auditCtx._flushed = true;

    const durationMs = Date.now() - startedAt;
    const httpStatus = res.statusCode;

    // Flush all queued audit entries
    for (const entry of req.auditCtx._queue) {
      // Enrich with computed values
      const enriched = {
        ...entry,
        meta: {
          ...entry.meta,
          durationMs: entry.meta?.durationMs ?? durationMs,
          httpStatus: entry.meta?.httpStatus ?? httpStatus,
        },
      };
      logAudit(req, enriched).catch(() => {});
    }

    req.auditCtx._queue = [];
  });

  next();
}

/**
 * Get audit context from request (safe accessor)
 */
export function getAuditCtx(req) {
  return req.auditCtx || {
    requestId: req.requestId || null,
    startedAt: Date.now(),
    ip: req.ip || null,
    userAgent: req.get?.("user-agent") || null,
    lang: null,
    idempotencyKey: null,
    method: req.method,
    path: req.originalUrl || req.url,
    _queue: [],
    _flushed: true,
  };
}

export default auditContext;
