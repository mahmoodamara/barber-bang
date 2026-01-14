import { ZodError } from "zod";
import { logger } from "../utils/logger.js";

const messageMap = {
  AUTH_REQUIRED: "Authentication required",
  AUTH_INVALID: "Invalid token",
  FORBIDDEN: "Forbidden",
  INVALID_ID: "Invalid id format",
  EMAIL_ALREADY_EXISTS: "Email already exists",
  PHONE_ALREADY_EXISTS: "Phone already exists",
  DUPLICATE_KEY: "Duplicate value",
  INVALID_CREDENTIALS: "Invalid credentials",
  ACCOUNT_LOCKED: "Account temporarily locked due to failed logins",
  CATEGORY_NOT_FOUND: "Category not found",
  PRODUCT_NOT_FOUND: "Product not found",
  VARIANT_NOT_FOUND: "Variant not found",
  STOCK_BELOW_RESERVED: "Stock cannot go below reserved",
  STOCK_NEGATIVE: "Stock cannot be negative",
  STOCK_CONSTRAINT_FAILED: "Stock update violates constraints",
  INVALID_SLUG: "Invalid slug format",
  CATEGORY_CYCLE: "Invalid category parent (cycle detected)",
  PARENT_NOT_FOUND: "Parent category not found",
  INVALID_OBJECT_ID: "Invalid id format",
};

function normalizeError(err) {
  // ZodError => 400 + تفاصيل مختصرة للحقول
  if (err instanceof ZodError) {
    const issues = err.issues?.map((i) => ({
      path: i.path?.join(".") || "",
      code: i.code,
      message: i.message,
    }));
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Invalid request",
      details: issues,
    };
  }

  if (err?.name === "CastError") {
    return {
      statusCode: 400,
      code: "INVALID_ID",
      message: messageMap.INVALID_ID,
      details: [{ path: err.path, value: err.value, kind: err.kind }],
    };
  }

  if (err?.name === "ValidationError") {
    const issues = Object.values(err.errors || {}).map((e) => ({
      path: e?.path,
      message: e?.message,
      kind: e?.kind,
    }));
    return {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Invalid request",
      details: issues,
    };
  }

  if (err?.code === 11000) {
    const fields = Object.keys(err?.keyPattern || err?.keyValue || {});
    return {
      statusCode: 409,
      code: "DUPLICATE_KEY",
      message: messageMap.DUPLICATE_KEY,
      details: fields.length ? [{ fields }] : undefined,
    };
  }

  const statusCode = Number(err?.statusCode || err?.status || 500);
  const code = err?.code || err?.message || "INTERNAL_ERROR";
  const rawMessage = typeof err?.message === "string" ? err.message.trim() : "";
  const msg =
    statusCode < 500
      ? (rawMessage && rawMessage !== code ? rawMessage : messageMap[code] || rawMessage || "Request failed")
      : messageMap[code] || "Server error";

  return {
    statusCode,
    code,
    message: msg,
    details: err?.details,
  };
}

export function errorHandler(err, req, res, _next) {
  const norm = normalizeError(err);
  const isOrders = req.originalUrl?.startsWith("/api/v1/orders");
  const isCheckout = isOrders && req.originalUrl?.includes("/checkout");
  const requestId = req.requestId || req.id || null;

  // log server errors + optionally 4xx (حسب رغبتك)
  if (norm.statusCode >= 500) {
    logger.error(
      {
        err,
        requestId,
        path: req.originalUrl,
        method: req.method,
      },
      "Unhandled error",
    );
  }
  if (isOrders) {
    if (norm.statusCode >= 500) {
      logger.error(
        {
          err,
          requestId,
          path: req.originalUrl,
          method: req.method,
          code: norm.code,
          details: norm.details,
        },
        isCheckout ? "Checkout request failed" : "Orders request failed",
      );
    } else if (norm.statusCode >= 400) {
      logger.warn(
        {
          requestId,
          path: req.originalUrl,
          method: req.method,
          code: norm.code,
          details: norm.details,
        },
        isCheckout ? "Checkout request failed" : "Orders request failed",
      );
    }
  }

  const payload = {
    ok: false,
    error: {
      code: norm.code,
      message: norm.message,
      requestId,
      ...(norm.details ? { details: norm.details } : {}),
    },
  };

  res.status(norm.statusCode).json(payload);
}
