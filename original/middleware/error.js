// src/middleware/error.js

import crypto from "crypto";
import { maskPII } from "../utils/maskPII.js";

function makeRequestId(req) {
  // Prefer requestId set by app middleware
  if (req?.requestId) return String(req.requestId);

  // Prefer upstream request id if exists (Render / proxy / CF)
  const incoming =
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    req.headers["cf-ray"];

  if (incoming) return String(incoming);

  // fallback: stable per response
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
}

export function getRequestId(req) {
  return makeRequestId(req);
}

function isZodError(err) {
  return err && Array.isArray(err.issues) && err.name === "ZodError";
}

function formatZodIssues(err) {
  return (err.issues || []).map((i) => ({
    path: Array.isArray(i.path) ? i.path.join(".") : String(i.path || ""),
    message: i.message,
  }));
}

export function notFound(req, res) {
  const requestId = getRequestId(req);

  res.status(404).json({
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "API route not found",
      requestId,
      path: req.originalUrl || req.url || "",
    },
  });
}

/**
 * Central error middleware
 * Always returns:
 * {
 *   ok:false,
 *   error:{ code, message, requestId, path, details? }
 * }
 */
export function errorHandler(err, req, res, _next) {
  const requestId = getRequestId(req);

  // Default mapping
  let status = err?.statusCode || err?.status || 500;
  let code = err?.code || "SERVER_ERROR";
  let message = err?.message || "Unexpected server error";
  let details = undefined;

  /**
   * ✅ Zod validation errors
   */
  if (isZodError(err)) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "Validation failed";
    details = formatZodIssues(err);
  }

  /**
   * ✅ Mongo invalid ObjectId cast
   */
  if (err?.name === "CastError") {
    status = 400;
    code = "INVALID_ID";
    message = "Invalid identifier";
  }

  /**
   * ✅ Mongo duplicate key errors
   */
  if (err?.code === 11000) {
    status = 409;
    code = "DUPLICATE_KEY";
    message = "Duplicate value";
    details = err?.keyValue || undefined;
  }

  /**
   * ✅ CORS errors from our cors callback
   */
  if (message === "CORS_NOT_ALLOWED" || code === "CORS_NOT_ALLOWED") {
    status = 403;
    code = "CORS_NOT_ALLOWED";
    message = "CORS origin not allowed";
  }

  /**
   * ✅ Stripe signature verification errors often include "No signatures found"
   * Keep this generic (do not leak raw values)
   */
  if (String(message || "").toLowerCase().includes("signature")) {
    if (status === 500) status = 400;
    code = "INVALID_STRIPE_SIGNATURE";
    message = "Invalid Stripe webhook signature";
  }

  /**
   * ✅ Avoid returning HTML errors / header already sent
   */
  if (res.headersSent) {
    return;
  }

  // Normalize status
  if (status < 400 || status > 599) status = 500;

  // Log only in non-prod (avoid request body, mask headers)
  if (process.env.NODE_ENV !== "production") {
    const safeHeaders = maskPII(req.headers || {});
    console.error("[error]", {
      requestId,
      path: req.originalUrl,
      status,
      code,
      message,
      headers: safeHeaders,
      stack: err?.stack,
    });
  }

  // Response envelope
  const payload = {
    ok: false,
    error: {
      code,
      message,
      requestId,
      path: req.originalUrl || req.url || "",
      ...(details ? { details } : {}),
    },
  };

  res.status(status).json(payload);
}
