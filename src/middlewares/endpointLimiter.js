const buckets = new Map();

function nowMs() {
  return Date.now();
}

function keyFor(req, scope) {
  const ip = req.ip || "unknown";
  const uid = req.auth?.userId || "anon";
  return `${scope}:${uid}:${ip}`;
}

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function endpointLimiter({ scope, windowMs, max, messageCode }) {
  const W = Math.max(250, Number(windowMs || 10_000));
  const M = Math.max(1, Number(max || 10));

  return (req, res, next) => {
    const k = keyFor(req, scope);
    const t = nowMs();
    const entry = buckets.get(k) || { resetAt: t + W, count: 0 };

    if (t > entry.resetAt) {
      entry.resetAt = t + W;
      entry.count = 0;
    }

    entry.count += 1;
    buckets.set(k, entry);

    if (entry.count > M) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader("X-RateLimit-Limit", String(M));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return next(
        httpError(429, messageCode || "RATE_LIMITED", "Too many requests", {
          retryAfterSeconds,
        }),
      );
    }

    next();
  };
}

// periodic cleanup to prevent unbounded growth
setInterval(() => {
  const t = nowMs();
  for (const [k, v] of buckets.entries()) {
    if (t > v.resetAt + 60_000) buckets.delete(k);
  }
}, 60_000).unref();
