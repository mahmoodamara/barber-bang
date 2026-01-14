// src/services/audit.service.js
/**
 * Production-grade Audit Service
 *
 * Features:
 * - Comprehensive redaction of sensitive data
 * - Actor context building from requests
 * - Safe async logging (never breaks requests)
 * - Diff tracking for updates
 * - Support for both new and legacy schemas
 */

import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.js";
import { ENV } from "../utils/env.js";
import { logger } from "../utils/logger.js";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const MAX_STRING_LENGTH = 500;
const MAX_META_SIZE = 8 * 1024; // 8KB max for meta object
const MAX_ARRAY_ITEMS = 10;
const MAX_DIFF_FIELDS = 20;

// Sensitive field patterns (case-insensitive)
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /refresh/i,
  /authorization/i,
  /cookie/i,
  /otp/i,
  /code/i,
  /pin/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /expiry/i,
  /stripe.*key/i,
  /client_secret/i,
  /api_?key/i,
  /private/i,
  /credential/i,
  /hash/i,
];

// Fields to always redact (exact matches)
const REDACT_FIELDS = new Set([
  "password",
  "passwordHash",
  "newPassword",
  "oldPassword",
  "confirmPassword",
  "token",
  "refreshToken",
  "accessToken",
  "authorization",
  "cookie",
  "cookies",
  "otp",
  "otpCode",
  "code",
  "verificationCode",
  "resetToken",
  "resetCode",
  "pin",
  "cardNumber",
  "cardCvv",
  "cardCvc",
  "cardExpiry",
  "cvv",
  "cvc",
  "stripeSecretKey",
  "stripeWebhookSecret",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "secret",
]);

// Fields to truncate for addresses (privacy)
const ADDRESS_TRUNCATE_FIELDS = new Set([
  "street",
  "streetAddress",
  "address1",
  "address2",
  "apartment",
  "apt",
  "suite",
  "unit",
  "floor",
  "building",
  "houseNumber",
  "zipCode",
  "postalCode",
  "phone",
  "phoneNumber",
  "mobile",
]);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function oidOrNull(v) {
  if (!v) return null;
  const s = String(v);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function safeString(v, max = MAX_STRING_LENGTH) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function isSensitiveKey(key) {
  if (!key || typeof key !== "string") return false;
  const lowerKey = key.toLowerCase();

  // Check exact matches
  if (REDACT_FIELDS.has(key) || REDACT_FIELDS.has(lowerKey)) return true;

  // Check patterns
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
}

function isAddressField(key) {
  if (!key || typeof key !== "string") return false;
  return ADDRESS_TRUNCATE_FIELDS.has(key);
}

/**
 * Deep sanitize an object, removing sensitive data
 */
function sanitizeValue(value, key = "", depth = 0) {
  // Prevent infinite recursion
  if (depth > 10) return "[MAX_DEPTH]";

  // Check if this key is sensitive
  if (isSensitiveKey(key)) {
    return "[REDACTED]";
  }

  // Handle null/undefined
  if (value === null || value === undefined) return value;

  // Handle primitives
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    // Truncate address fields for privacy
    if (isAddressField(key) && value.length > 3) {
      return value.slice(0, 3) + "***";
    }
    return safeString(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const truncated = value.slice(0, MAX_ARRAY_ITEMS);
    const sanitized = truncated.map((item, i) => sanitizeValue(item, String(i), depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      sanitized.push(`[...${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return sanitized;
  }

  // Handle Date
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle ObjectId
  if (mongoose.Types.ObjectId.isValid(value) && typeof value.toString === "function") {
    return String(value);
  }

  // Handle objects
  if (typeof value === "object") {
    const sanitized = {};
    const keys = Object.keys(value);

    for (const k of keys) {
      // Skip functions
      if (typeof value[k] === "function") continue;

      sanitized[k] = sanitizeValue(value[k], k, depth + 1);
    }

    return sanitized;
  }

  return String(value);
}

/**
 * Sanitize audit metadata, enforcing size limits
 */
export function sanitizeAuditMeta(obj) {
  if (!obj || typeof obj !== "object") return {};

  const sanitized = sanitizeValue(obj);

  // Check size and truncate if needed
  try {
    const json = JSON.stringify(sanitized);
    if (json.length > MAX_META_SIZE) {
      return {
        _truncated: true,
        _originalSize: json.length,
        _message: "Metadata truncated due to size limits",
      };
    }
  } catch {
    return { _error: "Failed to serialize metadata" };
  }

  return sanitized;
}

/**
 * Build actor context from request
 */
export function buildActor(req) {
  const auth = req.auth || {};
  const userId = auth.userId || auth.id || auth._id;
  const roles = Array.isArray(auth.roles) ? auth.roles : [];
  const email = auth.email ? String(auth.email).toLowerCase().trim() : null;

  // Determine actor type based on roles
  let actorType = "anonymous";
  if (userId) {
    if (roles.includes("admin")) {
      actorType = "admin";
    } else if (roles.includes("staff")) {
      actorType = "staff";
    } else {
      actorType = "user";
    }
  }

  return {
    actorType,
    userId: oidOrNull(userId),
    email: safeString(email, 180),
    roles: roles.map((r) => safeString(r, 50)).slice(0, 10),
  };
}

/**
 * Build route info from request
 */
function buildRoute(req) {
  return {
    method: req.method || null,
    path: safeString(req.originalUrl || req.url || req.path, 300),
  };
}

/**
 * Build meta from request context
 */
function buildMeta(req, entry = {}) {
  const ctx = req.auditCtx || {};

  return {
    lang: ctx.lang || entry.meta?.lang || null,
    idempotencyKey: safeString(ctx.idempotencyKey || entry.meta?.idempotencyKey, 120),
    durationMs: entry.meta?.durationMs ?? null,
    httpStatus: entry.meta?.httpStatus ?? null,
  };
}

/**
 * Build error info (with stack control)
 */
function buildError(err, includeStack = false) {
  if (!err) return null;

  const shouldIncludeStack =
    includeStack ||
    (ENV.NODE_ENV !== "production" && process.env.AUDIT_LOG_STACK !== "false") ||
    process.env.AUDIT_LOG_STACK === "true";

  return {
    code: safeString(err.code || err.name, 80),
    message: safeString(err.message, 500),
    stack: shouldIncludeStack ? safeString(err.stack, 2000) : null,
  };
}

/**
 * Compute diff between two objects (for updates)
 */
export function computeDiff(before, after, maxFields = MAX_DIFF_FIELDS) {
  if (!before || !after) return null;
  if (typeof before !== "object" || typeof after !== "object") return null;

  const diff = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let fieldCount = 0;

  for (const key of allKeys) {
    if (fieldCount >= maxFields) {
      diff._truncated = true;
      break;
    }

    // Skip sensitive fields
    if (isSensitiveKey(key)) continue;

    const beforeVal = before[key];
    const afterVal = after[key];

    // Simple equality check (not deep)
    const beforeStr = JSON.stringify(beforeVal);
    const afterStr = JSON.stringify(afterVal);

    if (beforeStr !== afterStr) {
      diff[key] = {
        before: sanitizeValue(beforeVal, key),
        after: sanitizeValue(afterVal, key),
      };
      fieldCount++;
    }
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

// ─────────────────────────────────────────────────────────────
// Main Logging Functions
// ─────────────────────────────────────────────────────────────

/**
 * Write audit log (best-effort, never throws)
 */
export async function logAudit(req, entry) {
  try {
    const actor = buildActor(req);
    const route = buildRoute(req);
    const meta = buildMeta(req, entry);
    const ctx = req.auditCtx || {};

    const doc = {
      // Request context
      requestId: safeString(req.requestId || ctx.requestId, 120),

      // Actor (new schema)
      actor,

      // Legacy actor fields (for backward compatibility)
      actorId: actor.userId,
      actorRoles: actor.roles,
      actorEmail: actor.email,

      // Action
      action: safeString(entry.action, 120),
      event: safeString(entry.action, 120), // legacy alias

      // Entity (new schema)
      entity: {
        entityType: safeString(entry.entityType || entry.entity?.entityType, 80),
        entityId: safeString(entry.entityId || entry.entity?.entityId, 100),
      },

      // Legacy entity fields
      resource: safeString(entry.entityType || entry.entity?.entityType, 80),
      targetId: oidOrNull(entry.entityId || entry.entity?.entityId),

      // Status
      status: entry.status === "fail" ? "fail" : "success",
      outcome: entry.status === "fail" ? "failure" : "success", // legacy

      // Severity
      severity: entry.severity || (entry.status === "fail" ? "warn" : "info"),

      // Request metadata
      ip: safeString(req.ip || ctx.ip, 80),
      userAgent: safeString(req.get?.("user-agent") || ctx.userAgent, 500),
      route,
      meta,

      // Legacy status code
      statusCode: meta.httpStatus,

      // Diff for updates
      diff: entry.diff ? sanitizeAuditMeta(entry.diff) : null,

      // Error details
      error: entry.error ? buildError(entry.error) : null,

      // Message
      message: safeString(entry.message, 500) || "",

      // Tags
      tags: Array.isArray(entry.tags) ? entry.tags.map((t) => safeString(t, 50)).slice(0, 20) : [],
    };

    await AuditLog.create(doc);
  } catch (err) {
    // Best-effort: log to console but never break the request
    logger.error({ err: err.message, action: entry?.action }, "Audit log write failed");
  }
}

/**
 * Log successful action
 */
export async function logAuditSuccess(req, action, entity = {}, options = {}) {
  return logAudit(req, {
    action,
    entityType: entity.type || entity.entityType,
    entityId: entity.id || entity.entityId,
    status: "success",
    severity: "info",
    diff: options.diff,
    message: options.message,
    tags: options.tags,
    meta: options.meta,
  });
}

/**
 * Log failed action
 */
export async function logAuditFail(req, action, entity = {}, error = null, options = {}) {
  return logAudit(req, {
    action,
    entityType: entity.type || entity.entityType,
    entityId: entity.id || entity.entityId,
    status: "fail",
    severity: options.severity || "warn",
    error: error instanceof Error ? error : { message: String(error || "Unknown error") },
    message: options.message || (error?.message ? String(error.message) : null),
    tags: options.tags,
    meta: options.meta,
  });
}

// ─────────────────────────────────────────────────────────────
// Legacy API (backward compatibility)
// ─────────────────────────────────────────────────────────────

/**
 * Legacy logAdminAction function (for backward compatibility)
 * Maps to new schema while maintaining old interface
 */
export async function logAdminAction({
  actorId,
  actorRoles,
  actorEmail,
  action,
  entityType,
  entityId,
  event,
  requestId,
  ip,
  userAgent,
  outcome = "success",
  statusCode = null,
  message = "",
  meta = {},
} = {}) {
  try {
    const doc = {
      requestId: safeString(requestId, 120),

      // Actor (new schema)
      actor: {
        actorType: actorRoles?.includes("admin") ? "admin" : actorRoles?.includes("staff") ? "staff" : "user",
        userId: oidOrNull(actorId),
        email: safeString(actorEmail, 180),
        roles: Array.isArray(actorRoles) ? actorRoles.map((r) => String(r)) : [],
      },

      // Legacy actor fields
      actorId: oidOrNull(actorId),
      actorRoles: Array.isArray(actorRoles) ? actorRoles.map((r) => String(r)) : [],
      actorEmail: safeString(actorEmail, 180),

      // Action
      action: safeString(event || action || "ADMIN_ACTION", 120),
      event: safeString(event || action || "ADMIN_ACTION", 120),

      // Entity
      entity: {
        entityType: safeString(entityType, 80),
        entityId: safeString(entityId, 100),
      },
      resource: safeString(entityType, 80),
      targetId: oidOrNull(entityId),

      // Status
      status: outcome === "failure" ? "fail" : "success",
      outcome: outcome === "failure" ? "failure" : "success",
      severity: outcome === "failure" ? "warn" : "info",

      // Request metadata
      ip: safeString(ip, 80),
      userAgent: safeString(userAgent, 500),
      statusCode: Number.isFinite(statusCode) ? Number(statusCode) : null,

      // Message and meta
      message: safeString(message, 500) || "",
      metaLegacy: meta && typeof meta === "object" ? sanitizeAuditMeta(meta) : {},
    };

    await AuditLog.create(doc);
  } catch {
    // best-effort: do not throw
  }
}

// ─────────────────────────────────────────────────────────────
// Query Functions (for admin endpoint)
// ─────────────────────────────────────────────────────────────

/**
 * List audit logs with flexible filtering
 */
export async function listAuditLogs({ q }) {
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  const skip = (page - 1) * limit;

  const filter = {};

  // Date range
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(q.from);
    if (q.to) filter.createdAt.$lte = new Date(q.to);
  }

  // Actor filters
  const actorId = oidOrNull(q.actorId);
  if (q.actorId && actorId) {
    filter.$or = [{ "actor.userId": actorId }, { actorId: actorId }];
  }

  // Entity filters
  if (q.entityType) {
    filter.$or = filter.$or || [];
    filter.$or.push(
      { "entity.entityType": String(q.entityType).trim() },
      { resource: String(q.entityType).trim() },
    );
  }

  const targetId = oidOrNull(q.entityId || q.targetId);
  if (targetId) {
    filter.$or = filter.$or || [];
    filter.$or.push({ "entity.entityId": String(targetId) }, { targetId: targetId });
  }

  // Action/event filter
  if (q.action || q.event) {
    const actionStr = String(q.action || q.event).trim();
    filter.$or = filter.$or || [];
    filter.$or.push({ action: actionStr }, { event: actionStr });
  }

  // Status filter
  if (q.status) {
    const statusStr = String(q.status).trim().toLowerCase();
    if (statusStr === "fail" || statusStr === "failure") {
      filter.$or = filter.$or || [];
      filter.$or.push({ status: "fail" }, { outcome: "failure" });
    } else if (statusStr === "success") {
      filter.$or = filter.$or || [];
      filter.$or.push({ status: "success" }, { outcome: "success" });
    }
  }

  // Legacy outcome filter
  if (q.outcome && !q.status) {
    filter.outcome = String(q.outcome).trim();
  }

  // Legacy resource filter
  if (q.resource && !q.entityType) {
    filter.resource = String(q.resource).trim();
  }

  // Severity filter
  if (q.severity) {
    filter.severity = String(q.severity).trim();
  }

  // Actor type filter
  if (q.actorType) {
    filter["actor.actorType"] = String(q.actorType).trim();
  }

  // Include system logs
  if (q.includeSystem === false) {
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [{ "actor.userId": { $ne: null } }, { actorId: { $ne: null } }],
    });
  }

  // Text search
  const search = String(q.q || "").trim();
  const sort = search ? { score: { $meta: "textScore" }, createdAt: -1 } : { createdAt: -1 };
  if (search) filter.$text = { $search: search };

  const projection = search ? { score: { $meta: "textScore" } } : {};

  const [items, total] = await Promise.all([
    AuditLog.find(filter, projection).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    items: items.map((x) => ({
      id: String(x._id),

      // Actor info (prefer new schema)
      actor: x.actor?.actorType
        ? {
            actorType: x.actor.actorType,
            userId: x.actor.userId ? String(x.actor.userId) : null,
            email: x.actor.email || null,
            roles: x.actor.roles || [],
          }
        : {
            actorType: x.actorId ? "user" : "anonymous",
            userId: x.actorId ? String(x.actorId) : null,
            email: x.actorEmail || null,
            roles: x.actorRoles || [],
          },

      // Legacy actor fields
      actorId: x.actorId ? String(x.actorId) : x.actor?.userId ? String(x.actor.userId) : null,
      actorRoles: x.actorRoles?.length ? x.actorRoles : x.actor?.roles || [],
      actorEmail: x.actorEmail || x.actor?.email || null,

      // Request context
      requestId: x.requestId || null,
      ip: x.ip || null,
      userAgent: x.userAgent || null,

      // Action
      action: x.action || x.event,
      event: x.event || x.action,

      // Entity info
      entity: {
        entityType: x.entity?.entityType || x.resource || null,
        entityId: x.entity?.entityId || (x.targetId ? String(x.targetId) : null),
      },
      entityType: x.entity?.entityType || x.resource || null,
      entityId: x.entity?.entityId || (x.targetId ? String(x.targetId) : null),

      // Status
      status: x.status || (x.outcome === "failure" ? "fail" : "success"),
      outcome: x.outcome || (x.status === "fail" ? "failure" : "success"),
      severity: x.severity || "info",

      // Metadata
      route: x.route || null,
      meta: x.meta || x.metaLegacy || {},
      statusCode: x.statusCode ?? x.meta?.httpStatus ?? null,

      // Diff and error
      diff: x.diff || null,
      error: x.error || null,

      // Message and tags
      message: x.message || "",
      tags: x.tags || [],

      // Timestamps
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
    })),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ─────────────────────────────────────────────────────────────
// Action Constants (for consistent naming)
// ─────────────────────────────────────────────────────────────

export const AuditActions = {
  // Auth
  AUTH_REGISTER: "AUTH_REGISTER",
  AUTH_LOGIN: "AUTH_LOGIN",
  AUTH_LOGOUT: "AUTH_LOGOUT",
  AUTH_LOGOUT_ALL: "AUTH_LOGOUT_ALL",
  AUTH_REFRESH: "AUTH_REFRESH",
  AUTH_VERIFY_EMAIL_OTP: "AUTH_VERIFY_EMAIL_OTP",
  AUTH_RESEND_EMAIL_OTP: "AUTH_RESEND_EMAIL_OTP",
  AUTH_FORGOT_PASSWORD: "AUTH_FORGOT_PASSWORD",
  AUTH_RESET_PASSWORD: "AUTH_RESET_PASSWORD",

  // Cart
  CART_ADD_ITEM: "CART_ADD_ITEM",
  CART_SET_QTY: "CART_SET_QTY",
  CART_REMOVE_ITEM: "CART_REMOVE_ITEM",
  CART_CLEAR: "CART_CLEAR",

  // Wishlist
  WISHLIST_ADD: "WISHLIST_ADD",
  WISHLIST_REMOVE: "WISHLIST_REMOVE",
  WISHLIST_CLEAR: "WISHLIST_CLEAR",

  // Orders
  ORDER_CREATE_DRAFT: "ORDER_CREATE_DRAFT",
  ORDER_APPLY_COUPON: "ORDER_APPLY_COUPON",
  ORDER_REMOVE_COUPON: "ORDER_REMOVE_COUPON",
  ORDER_SET_SHIPPING: "ORDER_SET_SHIPPING",
  ORDER_CHECKOUT_START: "ORDER_CHECKOUT_START",
  ORDER_CANCEL: "ORDER_CANCEL",
  ORDER_FINALIZE_PAID: "ORDER_FINALIZE_PAID",

  // Returns / RMA
  RETURN_REQUEST_CREATE: "RETURN_REQUEST_CREATE",
  RETURN_REQUEST_CANCEL: "RETURN_REQUEST_CANCEL",

  // Stripe
  STRIPE_WEBHOOK_RECEIVED: "STRIPE_WEBHOOK_RECEIVED",
  STRIPE_CHECKOUT_COMPLETED: "STRIPE_CHECKOUT_COMPLETED",

  // Admin - Categories
  ADMIN_CATEGORY_CREATE: "ADMIN_CATEGORY_CREATE",
  ADMIN_CATEGORY_UPDATE: "ADMIN_CATEGORY_UPDATE",
  ADMIN_CATEGORY_DELETE: "ADMIN_CATEGORY_DELETE",

  // Admin - Products
  ADMIN_PRODUCT_CREATE: "ADMIN_PRODUCT_CREATE",
  ADMIN_PRODUCT_UPDATE: "ADMIN_PRODUCT_UPDATE",
  ADMIN_PRODUCT_DELETE: "ADMIN_PRODUCT_DELETE",

  // Admin - Variants
  ADMIN_VARIANT_CREATE: "ADMIN_VARIANT_CREATE",
  ADMIN_VARIANT_UPDATE: "ADMIN_VARIANT_UPDATE",
  ADMIN_VARIANT_DELETE: "ADMIN_VARIANT_DELETE",
  ADMIN_VARIANT_STOCK_ADJUST: "ADMIN_VARIANT_STOCK_ADJUST",

  // Admin - Coupons
  ADMIN_COUPON_CREATE: "ADMIN_COUPON_CREATE",
  ADMIN_COUPON_UPDATE: "ADMIN_COUPON_UPDATE",
  ADMIN_COUPON_DEACTIVATE: "ADMIN_COUPON_DEACTIVATE",

  // Admin - Promotions
  ADMIN_PROMOTION_CREATE: "ADMIN_PROMOTION_CREATE",
  ADMIN_PROMOTION_UPDATE: "ADMIN_PROMOTION_UPDATE",
  ADMIN_PROMOTION_DEACTIVATE: "ADMIN_PROMOTION_DEACTIVATE",

  // Admin - Shipping
  ADMIN_SHIPPING_CREATE: "ADMIN_SHIPPING_CREATE",
  ADMIN_SHIPPING_UPDATE: "ADMIN_SHIPPING_UPDATE",
  ADMIN_SHIPPING_DELETE: "ADMIN_SHIPPING_DELETE",

  // Admin - Reviews
  ADMIN_REVIEW_APPROVE: "ADMIN_REVIEW_APPROVE",
  ADMIN_REVIEW_REJECT: "ADMIN_REVIEW_REJECT",
  ADMIN_REVIEW_DELETE: "ADMIN_REVIEW_DELETE",

  // Admin - Refunds
  ADMIN_ORDER_REFUND: "ADMIN_ORDER_REFUND",

  // Admin - Returns / RMA
  ADMIN_RETURN_DECISION: "ADMIN_RETURN_DECISION",
  ADMIN_RETURN_RECEIVED: "ADMIN_RETURN_RECEIVED",
  ADMIN_RETURN_CLOSE: "ADMIN_RETURN_CLOSE",

  // Admin - Users
  ADMIN_USER_UPDATE: "ADMIN_USER_UPDATE",
  ADMIN_USER_RESET_PASSWORD: "ADMIN_USER_RESET_PASSWORD",

  // Admin - Orders
  ADMIN_ORDER_STATUS_UPDATE: "ADMIN_ORDER_STATUS_UPDATE",
  ADMIN_ORDER_TRACKING_UPDATE: "ADMIN_ORDER_TRACKING_UPDATE",
  ADMIN_ORDER_NOTE_ADD: "ADMIN_ORDER_NOTE_ADD",
  ADMIN_ORDER_PAYMENT_RESOLVE: "ADMIN_ORDER_PAYMENT_RESOLVE",
  ADMIN_ORDER_FULFILLMENT_EVENT_ADD: "ADMIN_ORDER_FULFILLMENT_EVENT_ADD",
  ADMIN_COD_ACCEPT: "ADMIN_COD_ACCEPT",
  ADMIN_COD_REJECT: "ADMIN_COD_REJECT",

  // Admin - Jobs
  ADMIN_JOB_RETRY: "ADMIN_JOB_RETRY",
  ADMIN_JOB_RETRY_FAILED_BULK: "ADMIN_JOB_RETRY_FAILED_BULK",

  // Admin - Feature Flags
  ADMIN_FLAG_SET: "ADMIN_FLAG_SET",
  ADMIN_FLAG_DELETE: "ADMIN_FLAG_DELETE",

  // Reviews
  REVIEW_CREATE: "REVIEW_CREATE",
  REVIEW_UPDATE: "REVIEW_UPDATE",
  REVIEW_DELETE: "REVIEW_DELETE",
};

export default {
  logAudit,
  logAuditSuccess,
  logAuditFail,
  logAdminAction,
  listAuditLogs,
  sanitizeAuditMeta,
  buildActor,
  computeDiff,
  AuditActions,
};
