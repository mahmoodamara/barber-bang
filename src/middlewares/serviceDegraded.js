import { isHealthy, getUnhealthyReason } from "../utils/healthState.js";

const ALLOW_WHEN_DEGRADED = new Set([
  "/health",
  "/health/ready",
  "/webhooks/stripe", // future-proof
]);

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function serviceDegraded(req, res, next) {
  if (ALLOW_WHEN_DEGRADED.has(req.path)) return next();

  if (!isHealthy()) {
    return next(
      httpError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable", {
        reason: getUnhealthyReason(),
      }),
    );
  }

  next();
}
