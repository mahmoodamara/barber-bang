// src/utils/response.js
// Standardized API response helpers for consistent envelope format.

import { getRequestId } from "../middleware/error.js";

/**
 * Set Cache-Control and optional Vary for API responses (CDN + browser).
 * @param {object} res - Express response
 * @param {object} options
 * @param {number} [options.sMaxAge] - s-maxage in seconds (CDN)
 * @param {number} [options.staleWhileRevalidate] - stale-while-revalidate in seconds
 * @param {string} [options.vary] - Vary header value (e.g. "Accept-Language")
 */
export function setCacheHeaders(res, { sMaxAge, staleWhileRevalidate, vary } = {}) {
  if (sMaxAge != null && Number.isFinite(sMaxAge)) {
    const parts = ["public", `s-maxage=${sMaxAge}`];
    if (staleWhileRevalidate != null && Number.isFinite(staleWhileRevalidate)) {
      parts.push(`stale-while-revalidate=${staleWhileRevalidate}`);
    }
    res.setHeader("Cache-Control", parts.join(", "));
  }
  if (vary && typeof vary === "string") {
    res.setHeader("Vary", vary);
  }
}

/**
 * ✅ Performance: Set strict no-store for private/personalized endpoints.
 * Use for: cart, auth, checkout, orders, account, wishlist, returns.
 * @param {object} res - Express response
 */
export function setPrivateNoStore(res) {
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

/**
 * Send a success response with normalized envelope.
 * Returns both `ok: true` AND `success: true` for frontend compatibility.
 * { ok: true, success: true, data, meta? }
 * @param {object} res - Express response
 * @param {any} data - Response payload
 * @param {object} [meta] - Optional metadata (pagination, etc.)
 */
export function sendOk(res, data, meta = null) {
  const body = { ok: true, success: true, data };
  if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
    body.meta = meta;
  }
  return res.json(body);
}

/**
 * Send a created response (201) with normalized envelope.
 * { ok: true, success: true, data, meta? }
 * @param {object} res - Express response
 * @param {any} data - Response payload
 * @param {object} [meta] - Optional metadata
 */
export function sendCreated(res, data, meta = null) {
  const body = { ok: true, success: true, data };
  if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
    body.meta = meta;
  }
  return res.status(201).json(body);
}

/**
 * Send a no-content response (204).
 * @param {object} res - Express response
 */
export function sendNoContent(res) {
  return res.status(204).end();
}

/**
 * Send a success response for admin routes.
 * @deprecated Use sendOk() instead.
 */
export function sendAdminOk(res, data, meta = null) {
  return sendOk(res, data, meta);
}

/**
 * Send an error response with normalized envelope.
 * Returns both `ok: false` AND `success: false` for frontend compatibility.
 * { ok: false, success: false, error: { ... } }
 * @param {object} res - Express response
 * @param {number} status - HTTP status code
 * @param {string} code - Error code (e.g., "NOT_FOUND")
 * @param {string} message - Human-readable message
 * @param {object} [extra] - Additional fields to merge into error object
 */
export function sendError(res, status, code, message, extra = {}) {
  const req = res.req;
  return res.status(status).json({
    ok: false,
    success: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req?.originalUrl || req?.url || "",
      ...extra,
    },
  });
}

/**
 * Send an error response for admin routes.
 * @deprecated Use sendError() instead.
 */
export function sendAdminError(res, status, code, message, extra = {}) {
  return sendError(res, status, code, message, extra);
}
