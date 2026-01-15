// src/middlewares/envelopeV2.js
// Response Envelope v2 compatibility layer
// Enabled via header `X-Envelope: v2` or query `?envelope=v2`
//
// SUCCESS format:
//   { data: ..., meta: { pagination: { page, limit, total } } }
//
// ERROR format:
//   { error: { code, message, details } }

/**
 * Check if envelope v2 mode is requested
 */
export function isEnvelopeV2(req) {
  const headerVal = req.headers?.["x-envelope"];
  if (headerVal === "v2") return true;

  const queryVal = req.query?.envelope;
  if (queryVal === "v2") return true;

  return false;
}

/**
 * Transform a success response to v2 format
 */
function transformSuccessToV2(body) {
  if (!body || typeof body !== "object") {
    return { data: body ?? null };
  }

  // Already has data key - just ensure proper structure
  if (Object.prototype.hasOwnProperty.call(body, "data")) {
    const { ok, data, ...rest } = body;

    // Check for pagination fields
    const pagination = extractPagination(rest);
    const meta = pagination ? { pagination } : undefined;

    // Clean up: remove ok, page, limit, total from rest if they were pagination
    const cleanRest = { ...rest };
    delete cleanRest.page;
    delete cleanRest.limit;
    delete cleanRest.total;
    delete cleanRest.items;

    // If rest has meaningful data beyond pagination, include it
    const hasExtraFields = Object.keys(cleanRest).some((k) => k !== "lang");

    if (hasExtraFields) {
      return {
        data,
        ...cleanRest,
        ...(meta ? { meta } : {}),
      };
    }

    return {
      data,
      ...(meta ? { meta } : {}),
    };
  }

  // Common patterns: { ok, items, page, limit, total }
  const { ok, items, page, limit, total, ...rest } = body;

  if (Array.isArray(items)) {
    const pagination = { page, limit, total };
    const hasPagination = page !== undefined || limit !== undefined || total !== undefined;

    return {
      data: items,
      ...rest,
      ...(hasPagination ? { meta: { pagination } } : {}),
    };
  }

  // Pattern: { ok, product, ... } or { ok, wishlist, ... } etc.
  // Transform to { data: { product, ... } }
  const payload = { ...rest };
  if (items !== undefined) payload.items = items;

  return { data: Object.keys(payload).length ? payload : null };
}

/**
 * Extract pagination from body if present
 */
function extractPagination(body) {
  const { page, limit, total } = body;
  if (page === undefined && limit === undefined && total === undefined) {
    return null;
  }
  return { page, limit, total };
}

/**
 * Transform an error response to v2 format
 */
function transformErrorToV2(body) {
  if (!body || typeof body !== "object") {
    return { error: { code: "UNKNOWN_ERROR", message: String(body ?? "Unknown error") } };
  }

  // Already has error key - ensure proper structure
  if (body.error) {
    const { ok, error } = body;
    return {
      error: {
        code: error.code || "ERROR",
        message: error.message || "An error occurred",
        ...(error.details ? { details: error.details } : {}),
        ...(error.requestId ? { requestId: error.requestId } : {}),
      },
    };
  }

  // Extract error info from flat structure
  const { ok, code, message, details, requestId, ...rest } = body;
  return {
    error: {
      code: code || "ERROR",
      message: message || "An error occurred",
      ...(details ? { details } : {}),
      ...(requestId ? { requestId } : {}),
      ...rest,
    },
  };
}

/**
 * Envelope v2 middleware
 * Wraps res.json to transform responses when v2 mode is requested
 */
export function envelopeV2Middleware(req, res, next) {
  // Only intercept if v2 is requested
  if (!isEnvelopeV2(req)) {
    return next();
  }

  const originalJson = res.json.bind(res);

  res.json = (body) => {
    // Detect if this is an error response
    const isError =
      (body && body.ok === false) ||
      (res.statusCode >= 400);

    let transformed;
    if (isError) {
      transformed = transformErrorToV2(body);
    } else {
      transformed = transformSuccessToV2(body);
    }

    return originalJson(transformed);
  };

  next();
}

export default envelopeV2Middleware;
