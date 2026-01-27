// src/middleware/rateLimit.js
// Centralized rate-limit helpers for sensitive endpoints.
// Works with express-rate-limit (already used in app.js).

import rateLimit from "express-rate-limit";

function getClientIp(req) {
  // If app.set("trust proxy", 1) is enabled, req.ip is correct.
  // Otherwise this still works reasonably for direct connections.
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

function stableKeyGenerator(req) {
  // Key by IP + user agent (slightly improves fairness)
  const ip = getClientIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 80);
  return `${ip}:${ua}`;
}

/**
 * Create a basic limiter with sane defaults.
 */
export function createLimiter({
  windowMs = 60_000,
  limit = 60,
  messageCode = "RATE_LIMITED",
  messageText = "Too many requests, please try again later.",
  keyGenerator = stableKeyGenerator,
} = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => {
      res.status(429).json({
        ok: false,
        error: {
          code: messageCode,
          message: messageText,
        },
      });
    },
  });
}

/**
 * Recommended limiters for specific routes.
 * Tune values based on traffic.
 */
export const limitAuth = createLimiter({
  windowMs: 60_000,
  limit: 12,
  messageCode: "AUTH_RATE_LIMITED",
  messageText: "Too many auth attempts. Try again in a minute.",
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
