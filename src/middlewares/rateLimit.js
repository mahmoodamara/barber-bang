import { ENV } from "../utils/env.js";
import { logger } from "../utils/logger.js";

const RATE_LIMIT_WINDOW_MS = toPositiveInt(ENV.AUTH_LIMIT_WINDOW_MS, 15 * 60_000);
const RATE_LIMIT_MAX = toPositiveInt(ENV.AUTH_LIMIT_MAX, 20);
const REDIS_URL = process.env.REDIS_URL;

// Optional: allow disabling limiter in tests/dev
const RATE_LIMIT_ENABLED =
  String(process.env.RATE_LIMIT_ENABLED ?? "true").toLowerCase() !== "false";

// For API ergonomics / clients
const RATE_LIMIT_HEADER_LIMIT = "X-RateLimit-Limit";
const RATE_LIMIT_HEADER_REMAINING = "X-RateLimit-Remaining";
const RATE_LIMIT_HEADER_RESET = "X-RateLimit-Reset";
const RATE_LIMIT_HEADER_RETRY_AFTER = "Retry-After";

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampStr(value, maxLen) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function getIp(req) {
  // Express sets req.ip based on trust proxy settings. Prefer it.
  const direct = typeof req.ip === "string" ? req.ip : "";
  if (direct) return clampStr(direct, 64);

  // Fallback: x-forwarded-for first hop
  const forwarded = req.headers?.["x-forwarded-for"];
  if (!forwarded) return "ip";
  const first = String(forwarded).split(",")[0]?.trim() || "ip";
  return clampStr(first, 64) || "ip";
}

function normalizeEmailLower(v) {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase();
}

function getEmailLower(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  return normalizeEmailLower(body.email);
}

// Avoid unbounded key size / accidental DoS via huge header/body
function makeKey(req, includeEmail) {
  const ip = getIp(req);
  if (!includeEmail) return ip;
  const email = clampStr(getEmailLower(req), 254);
  return email ? `${ip}::${email}` : ip;
}

class MemoryStore {
  constructor() {
    // WARNING: In-memory limiter is per-process; use a shared store for multi-instance deployments.
    this.store = new Map();
    this.lastPruneAt = 0;
  }

  pruneIfNeeded(now) {
    // Prevent unbounded growth: occasional sweep of expired entries.
    // Runs at most once per minute to keep overhead low.
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;

    for (const [key, entry] of this.store.entries()) {
      if (!entry || entry.resetAt <= now) this.store.delete(key);
    }
  }

  async increment(key, windowMs) {
    const now = Date.now();
    this.pruneIfNeeded(now);

    const entry = this.store.get(key);
    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowMs;
      this.store.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    }

    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }
}

// If REDIS_URL is set but no Redis client is configured in this repo, keep the in-memory limiter.
// This avoids a bespoke Redis protocol implementation in the auth path.
const store = new MemoryStore();
if (REDIS_URL) {
  logger.warn(
    { hasRedisUrl: true },
    "REDIS_URL set but no Redis client configured; using in-memory rate limiter",
  );
}

function setRateLimitHeaders(res, { limit, remaining, resetAt }) {
  res.set(RATE_LIMIT_HEADER_LIMIT, String(limit));
  res.set(RATE_LIMIT_HEADER_REMAINING, String(Math.max(0, remaining)));
  res.set(RATE_LIMIT_HEADER_RESET, String(Math.ceil(resetAt / 1000)));
}

function buildTooManyRequests(res, req, resetAt) {
  const retryAfter = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  res.set(RATE_LIMIT_HEADER_RETRY_AFTER, String(retryAfter));
  return res.status(429).json({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
      requestId: req.requestId,
      retryAfterSec: retryAfter,
    },
  });
}

function createLimiter({ keyPrefix, includeEmail }) {
  return async (req, res, next) => {
    // Allow skipping limiter (tests / internal environments)
    if (!RATE_LIMIT_ENABLED) return next();

    try {
      const key = `${keyPrefix}:${makeKey(req, includeEmail)}`;
      const { count, resetAt } = await store.increment(key, RATE_LIMIT_WINDOW_MS);

      // Standard semantics: remaining becomes 0 once you reach the limit.
      const remaining = RATE_LIMIT_MAX - Math.min(count, RATE_LIMIT_MAX);

      setRateLimitHeaders(res, {
        limit: RATE_LIMIT_MAX,
        remaining,
        resetAt,
      });

      if (count > RATE_LIMIT_MAX) {
        return buildTooManyRequests(res, req, resetAt);
      }

      return next();
    } catch (err) {
      // Fail open: do not block auth if limiter backend errors.
      logger.warn(
        { requestId: req.requestId, err: { name: err?.name, message: err?.message } },
        "Rate limiter error",
      );
      return next();
    }
  };
}

export const authRegisterLimiter = createLimiter({ keyPrefix: "register", includeEmail: false });
export const authLoginLimiter = createLimiter({ keyPrefix: "login", includeEmail: true });
export const authForgotPasswordLimiter = createLimiter({ keyPrefix: "forgot", includeEmail: true });
export const authVerifyOtpLimiter = createLimiter({ keyPrefix: "verify-otp", includeEmail: true });
export const authResendOtpLimiter = createLimiter({ keyPrefix: "resend-otp", includeEmail: true });
