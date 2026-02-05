// src/middleware/rateLimit.js
// Centralized rate-limit helpers for sensitive endpoints.
// Works with express-rate-limit (already used in app.js).
// Supports Redis store for multi-instance scalability (configurable via env).

import rateLimit from "express-rate-limit";
import { getRequestId } from "./error.js";

// Redis store singleton (lazy init)
let redisClient = null;
let redisStore = null;
let redisInitPromise = null;
let redisInitialized = false;

/**
 * Initialize Redis client for rate limiting (if REDIS_URL is configured)
 * This is called lazily when needed.
 */
async function initRedisStore() {
  if (redisInitPromise) return redisInitPromise;

  redisInitPromise = (async () => {
    const redisUrl = process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
    if (!redisUrl) {
      console.info("[rate-limit] No REDIS_URL configured, using memory store (not recommended for production)");
      redisInitialized = true;
      return null;
    }

    try {
      // Dynamic import to avoid hard dependency
      const { createClient } = await import("redis");
      const { RedisStore } = await import("rate-limit-redis");

      redisClient = createClient({ url: redisUrl });
      redisClient.on("error", (err) => {
        console.warn("[rate-limit] Redis client error:", String(err?.message || err));
      });

      await redisClient.connect();
      console.info("[rate-limit] Redis connected for rate limiting");

      redisStore = new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
        prefix: "rl:",
      });

      redisInitialized = true;
      return redisStore;
    } catch (err) {
      console.warn("[rate-limit] Redis init failed, falling back to memory store:", String(err?.message || err));
      redisClient = null;
      redisInitialized = true;
      return null;
    }
  })();

  return redisInitPromise;
}

function getClientIp(req) {
  const trustProxy = Boolean(req?.app?.get?.("trust proxy"));
  if (trustProxy) {
    return req.ip || "unknown";
  }

  // Direct connection: ignore X-Forwarded-For to prevent spoofing
  return req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

function stableKeyGenerator(req) {
  // Key by IP + user agent (slightly improves fairness)
  const ip = getClientIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 80);
  return `${ip}:${ua}`;
}

/**
 * Create a rate limiter handler that uses the correct messageCode
 * @param {string} messageCode - The error code to return
 * @param {string} messageText - The error message to return
 */
function createLimiterHandler(messageCode, messageText) {
  return (req, res) => {
    const requestId = getRequestId(req);
    res.status(429).json({
      ok: false,
      error: {
        code: messageCode,
        message: messageText,
        requestId,
        path: req.originalUrl || req.url || "",
      },
    });
  };
}

/**
 * Create a limiter factory function that will use Redis store when available.
 * The returned function creates a new limiter with the current store state.
 *
 * @param {Object} options - Limiter options
 * @returns {Function} - Factory function that returns the limiter middleware
 */
// Registry to track limiters that need upgrading when Redis connects
const upgradableLimiters = [];

/**
 * Create a limiter factory function that will use Redis store when available.
 * The returned function creates a new limiter with the current store state.
 *
 * @param {Object} options - Limiter options
 * @returns {Function} - Factory function that returns the limiter middleware
 */
function createLimiterFactory({
  windowMs = 60_000,
  limit = 60,
  messageCode = "RATE_LIMITED",
  messageText = "Too many requests, please try again later.",
  keyGenerator = stableKeyGenerator,
} = {}) {
  // Store the options for later limiter creation
  const opts = { windowMs, limit, messageCode, messageText, keyGenerator };

  // Helper to create the underlying limiter instance
  const createInstance = (store) => {
    return rateLimit({
      windowMs: opts.windowMs,
      limit: opts.limit,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: opts.keyGenerator,
      store: store || undefined,
      handler: createLimiterHandler(opts.messageCode, opts.messageText),
      validate: { trustProxy: false } // Disable strict validation for trust proxy
    });
  };

  // Initialize default (memory) limiter IMMEDIATELY
  let limiter = createInstance(redisStore);

  // Register for upgrade
  upgradableLimiters.push(() => {
    if (redisStore) {
      try {
        limiter = createInstance(redisStore);
        console.info(`[rate-limit] Limiter upgraded to Redis store (${opts.messageCode})`);
      } catch (e) {
        console.warn("[rate-limit] Failed to upgrade limiter:", e.message);
      }
    }
  });

  // The actual middleware just delegates to the current limiter instance
  return function rateLimitMiddleware(req, res, next) {
    return limiter(req, res, next);
  };
}

/**
 * Create a basic limiter with sane defaults.
 * Uses Redis store if available, falls back to memory store.
 * This is a factory-based limiter that will upgrade to Redis automatically.
 */
export function createLimiter(options = {}) {
  return createLimiterFactory(options);
}

/**
 * Initialize Redis store and enable Redis-backed rate limiting.
 * Call this once at app startup to enable Redis-backed rate limiting.
 * All existing limiter instances will automatically upgrade on next request.
 *
 * @returns {Promise<{store: RedisStore|null, isRedis: boolean}>}
 */
export async function initRateLimiters() {
  const store = await initRedisStore();

  if (store) {
    console.info("[rate-limit] Rate limiters will use Redis store");
    // Standardize upgrade: upgrade all registered limiters now
    for (const upgrade of upgradableLimiters) {
      upgrade();
    }
  }

  return {
    store,
    isRedis: !!store,
  };
}

/**
 * Check if Redis rate limiting is enabled
 */
export function isRedisRateLimitEnabled() {
  return !!redisStore;
}

/**
 * Get Redis connection status
 */
export function getRateLimitStatus() {
  return {
    initialized: redisInitialized,
    isRedis: !!redisStore,
    redisConnected: redisClient?.isOpen ?? false,
  };
}

/**
 * Recommended limiters for specific routes.
 * Tune values based on traffic.
 * These are factory-based limiters that will automatically upgrade to Redis
 * after initRateLimiters() is called.
 */
export const limitAuth = createLimiter({
  windowMs: 60_000,
  limit: 12,
  messageCode: "AUTH_RATE_LIMITED",
  messageText: "Too many auth attempts. Try again in a minute.",
});

/** Stricter limit for login only (brute-force protection) */
export const limitLogin = createLimiter({
  windowMs: 60_000,
  limit: 6,
  messageCode: "LOGIN_RATE_LIMITED",
  messageText: "Too many login attempts. Try again in a minute.",
});

/** Limit for register (prevents bulk signups) */
export const limitRegister = createLimiter({
  windowMs: 60_000,
  limit: 5,
  messageCode: "REGISTER_RATE_LIMITED",
  messageText: "Too many registration attempts. Try again in a minute.",
});

/** General auth routes (me, refresh, logout, change-password) */
export const limitAuthGeneral = createLimiter({
  windowMs: 60_000,
  limit: 30,
  messageCode: "AUTH_RATE_LIMITED",
  messageText: "Too many requests. Try again in a minute.",
});

/** Forgot password: strict limit to prevent abuse and enumeration */
export const limitForgotPassword = createLimiter({
  windowMs: 15 * 60_000, // 15 minutes
  limit: 3,
  messageCode: "FORGOT_PASSWORD_RATE_LIMITED",
  messageText: "Too many reset requests. Try again later.",
});

export const limitCheckoutQuote = createLimiter({
  windowMs: 60_000,
  limit: 40,
  messageCode: "QUOTE_RATE_LIMITED",
  messageText: "Too many quote requests. Please slow down.",
});

export const limitCheckoutCreate = createLimiter({
  windowMs: 60_000,
  limit: 25,
  messageCode: "CHECKOUT_RATE_LIMITED",
  messageText: "Too many checkout requests. Please slow down.",
});

export const limitTrackOrder = createLimiter({
  windowMs: 60_000,
  limit: 20,
  messageCode: "TRACK_RATE_LIMITED",
  messageText: "Too many tracking requests. Please try again shortly.",
});

export const limitReviewsWrite = createLimiter({
  windowMs: 60_000,
  limit: 15,
  messageCode: "REVIEWS_RATE_LIMITED",
  messageText: "Too many review requests. Please slow down.",
});

/**
 * ✅ Stricter rate limit for admin routes
 * Lower limits to protect sensitive operations
 */
export const limitAdmin = createLimiter({
  windowMs: 60_000,
  limit: 100,
  messageCode: "ADMIN_RATE_LIMITED",
  messageText: "Too many admin requests. Please slow down.",
});

export const limitAdminWrite = createLimiter({
  windowMs: 60_000,
  limit: 60,
  messageCode: "ADMIN_WRITE_RATE_LIMITED",
  messageText: "Too many admin write operations. Please slow down.",
});

/**
 * Stricter rate limit for media uploads
 * Prevents abuse of upload endpoint (resource-intensive operation)
 */
export const limitMediaUpload = createLimiter({
  windowMs: 60_000,
  limit: 10, // 10 uploads per minute (stricter for resource-intensive Cloudinary operations)
  messageCode: "UPLOAD_RATE_LIMITED",
  messageText: "Too many upload requests. Please slow down.",
});

/**
 * ✅ Rate limit for coupon validation endpoint
 * Prevents coupon code enumeration attacks
 */
export const limitCouponValidate = createLimiter({
  windowMs: 60_000,
  limit: 30,
  messageCode: "COUPON_VALIDATE_RATE_LIMITED",
  messageText: "Too many coupon validation requests. Please slow down.",
});

/**
 * ✅ Rate limit for cart endpoints
 * Prevents abuse of add/set-qty/remove/clear operations
 */
export const limitCart = createLimiter({
  windowMs: 60_000,
  limit: 80,
  messageCode: "CART_RATE_LIMITED",
  messageText: "Too many cart requests. Please slow down.",
});

/**
 * Create Redis-backed limiters dynamically after init.
 * Use this factory after calling initRateLimiters() for limiters that need Redis.
 */
export function createRedisLimiter(options) {
  if (!redisStore) {
    console.warn("[rate-limit] createRedisLimiter called but Redis not initialized, using memory store");
  }
  return createLimiter(options);
}
