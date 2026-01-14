import { RateLimitBucket } from "../models/RateLimitBucket.js";

function windowStart(nowMs, windowMs) {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export async function consumeRateLimit({ key, windowMs, max, ttlMs = 120000 }) {
  const now = Date.now();
  const ws = windowStart(now, windowMs);
  const expiresAt = new Date(ws + windowMs + ttlMs);

  const doc = await RateLimitBucket.findOneAndUpdate(
    { key, windowStartMs: ws },
    {
      $setOnInsert: { key, windowStartMs: ws, expiresAt },
      $inc: { count: 1 },
      $set: { expiresAt },
    },
    { new: true, upsert: true },
  ).lean();

  const remaining = Math.max(0, max - doc.count);
  const resetAt = ws + windowMs;

  return {
    allowed: doc.count <= max,
    remaining,
    resetAt,
    count: doc.count,
  };
}
