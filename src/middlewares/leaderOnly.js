import { ENV } from "../utils/env.js";
import { tryAcquireLease } from "../services/leaseLock.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export async function leaderOnly(_req, res, next) {
  const ownerId = String(ENV.INSTANCE_ID || "unknown").trim();
  const name = String(ENV.LEASE_NAME || "global-scheduler").trim();

  const ok = await tryAcquireLease({ name, ownerId });
  if (!ok) return next(httpError(409, "NOT_LEADER", "Not leader"));

  next();
}
