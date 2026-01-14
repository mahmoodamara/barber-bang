import rateLimit from "express-rate-limit";
import { ENV } from "../utils/env.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

// key: IP + (emailLower إذا موجود) لتقليل brute force على نفس الحساب
function keyForAuth(req) {
  const ip = req.ip || req.headers["x-forwarded-for"]?.toString()?.split(",")[0]?.trim() || "ip";
  const email =
    req.body?.email && typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return email ? `${ip}::${email}` : ip;
}

export const authLimiter = rateLimit({
  windowMs: Number(ENV.AUTH_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(ENV.AUTH_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyForAuth,
  handler: (req, res, next, options) => {
    const resetAt = req.rateLimit?.resetTime instanceof Date
      ? req.rateLimit.resetTime.getTime()
      : Date.now() + Number(options.windowMs || 60_000);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return next(
      httpError(429, "RATE_LIMITED", "Too many attempts. Please try again later.", {
        retryAfterSeconds,
      }),
    );
  },
});
