// src/middlewares/endpointLimiterMongo.js
import { ENV } from "../utils/env.js";
import { consumeRateLimit } from "../services/distributedLimiter.service.js";

/**
 * Distributed rate limiter (Mongo backend) — Hardened (Admin-grade)
 *
 * Goals:
 * - Never respond directly; always next(err) so centralized errorHandler formats envelope consistently.
 * - Emit standard rate-limit headers:
 *   - X-RateLimit-Limit
 *   - X-RateLimit-Remaining
 *   - X-RateLimit-Reset (SECONDS since epoch)
 *   - Retry-After (SECONDS) on 429
 * - Fail-closed for Admin endpoints by default (configurable via ENV.RATE_LIMIT_FAIL_OPEN).
 *
 * IMPORTANT:
 * - For correct req.ip behind proxies, ensure:
 *   app.set("trust proxy", 1) (or true) in src/api/app.js
 */

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function keyFor(req, scope) {
  const uid = req.auth?.userId ? String(req.auth.userId) : "anon";
  const ip = req.ip || "unknown";
  // Optional: separate per-user + per-ip to reduce noisy neighbor
  return `${scope}:${uid}:${ip}`;
}

function toInt(n, fallback) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function msToSecCeil(ms) {
  return Math.max(0, Math.ceil(Number(ms) / 1000));
}

export function endpointLimiterMongo({
  scope,
  windowMs,
  max,
  messageCode = "RATE_LIMITED",
} = {}) {
  if (!scope) throw new Error("endpointLimiterMongo requires { scope }");
  if (!windowMs) throw new Error("endpointLimiterMongo requires { windowMs }");
  if (!max) throw new Error("endpointLimiterMongo requires { max }");

  return async (req, res, next) => {
    try {
      // Only active when backend is mongo
      if (String(ENV.RATE_LIMIT_BACKEND || "mongo") !== "mongo") return next();

      // TTL for limiter rows (ms). Should be >= windowMs to avoid premature eviction.
      const ttlMs = toInt(ENV.RATE_LIMIT_TTL_MS, Math.max(120_000, Number(windowMs)));

      const out = await consumeRateLimit({
        key: keyFor(req, scope),
        windowMs: Number(windowMs),
        max: Number(max),
        ttlMs,
      });

      // Defensive shaping
      const remaining = Math.max(0, toInt(out?.remaining, 0));
      const resetAtMs = toInt(out?.resetAt, Date.now() + Number(windowMs));
      const allowed = Boolean(out?.allowed);

      // Standard headers (Reset is SECONDS since epoch)
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(msToSecCeil(resetAtMs)));

      if (!allowed) {
        const retryAfterSec = Math.max(1, msToSecCeil(resetAtMs - Date.now()));
        res.setHeader("Retry-After", String(retryAfterSec));

        return next(
          httpError(429, messageCode, "Too many requests", {
            scope,
            retryAfterSeconds: retryAfterSec,
            limit: Number(max),
            remaining,
            resetAt: resetAtMs,
          }),
        );
      }

      return next();
    } catch (e) {
      // Fail-open optional for non-admin paths or if desired operationally.
      // For Admin endpoints, failing closed is generally safer.
      const failOpen =
        String(ENV.RATE_LIMIT_FAIL_OPEN || "false").toLowerCase() === "true";

      if (failOpen) return next();

      return next(
        httpError(503, "RATE_LIMITER_FAILED", "Rate limiter unavailable", {
          scope,
        }),
      );
    }
  };
}
