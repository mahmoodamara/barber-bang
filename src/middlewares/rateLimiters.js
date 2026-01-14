import rateLimit from "express-rate-limit";
import { ENV } from "../utils/env.js";
import { consumeRateLimit } from "../services/distributedLimiter.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function keyFor(req) {
  const uid = req.auth?.userId ? String(req.auth.userId) : "anon";
  const ip = req.ip || "unknown";
  return `global:${uid}:${ip}`;
}

const memoryLimiter = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  max: ENV.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const resetAt = req.rateLimit?.resetTime instanceof Date
      ? req.rateLimit.resetTime.getTime()
      : Date.now() + Number(options.windowMs || 60_000);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return next(
      httpError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
        retryAfterSeconds,
      }),
    );
  },
});

export const globalLimiter = async (req, res, next) => {
  if (String(ENV.RATE_LIMIT_BACKEND || "memory") !== "mongo") {
    return memoryLimiter(req, res, next);
  }

  try {
    const windowMs = Number(ENV.RATE_LIMIT_WINDOW_MS || 60_000);
    const max = Number(ENV.RATE_LIMIT_MAX || 300);
    const ttlMs = Number(ENV.RATE_LIMIT_TTL_MS || 120_000);
    const out = await consumeRateLimit({ key: keyFor(req), windowMs, max, ttlMs });

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(out.remaining));
    res.setHeader("X-RateLimit-Reset", String(out.resetAt));

    if (!out.allowed) {
      const retryAfter = Math.max(1, Math.ceil((out.resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return next(
        httpError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
          retryAfterSeconds: retryAfter,
        }),
      );
    }
  } catch {
    // best-effort: do not fail requests if limiter errors
  }

  return next();
};
