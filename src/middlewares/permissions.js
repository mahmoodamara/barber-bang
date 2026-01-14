// src/middlewares/permissions.js
import { ENV } from "../utils/env.js";

/**
 * World-class RBAC permissions middleware
 *
 * Assumptions:
 * - requireAuth already ran and set req.auth = { userId, roles, email, ... }
 * - roles are strings like: "admin", "staff", "user", "superAdmin" (if present)
 *
 * Optional:
 * - req.auth.permissions can exist (DB-driven permissions). If present, we merge it.
 */

const ADMIN_ALLOW_ALL = String(ENV.RBAC_ADMIN_ALLOW_ALL ?? "true") === "true";

/**
 * Role -> permissions mapping (static baseline)
 * You can keep this minimal and move to DB later.
 */
const ROLE_PERMISSIONS = {
  admin: ["*"],

  // staff: example baseline (tweak to your policy)
  staff: [
    "catalog:read",
    "orders:read",
    "ops:read",
    "coupons:read",
    "shipping:read",
    "reviews:moderate", // if you allow staff moderation
    // DO NOT include refunds by default
  ],

  user: [],
};

function normalizePerm(p) {
  return String(p || "").trim().toLowerCase();
}

function buildPermissionSet(req) {
  const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
  const rolePerms = [];

  for (const r of roles) {
    const key = String(r || "").toLowerCase();
    const perms = ROLE_PERMISSIONS[key];
    if (Array.isArray(perms)) rolePerms.push(...perms);
  }

  const directPerms = Array.isArray(req.auth?.permissions) ? req.auth.permissions : [];
  const all = [...rolePerms, ...directPerms].map(normalizePerm).filter(Boolean);

  return new Set(all);
}

function hasPermission(set, required) {
  const p = normalizePerm(required);
  if (!p) return false;

  // wildcard
  if (set.has("*")) return true;

  // exact
  if (set.has(p)) return true;

  // prefix wildcard: e.g. "orders:*" allows "orders:refund"
  const [domain] = p.split(":");
  if (domain && set.has(`${domain}:*`)) return true;

  return false;
}

function forbidden(next, req, code = "FORBIDDEN", message = "Not allowed") {
  const err = new Error(message);
  err.statusCode = 403;
  err.code = code;
  err.requestId = req.requestId;
  return next(err);
}

export function requirePermission(permission, { code = "FORBIDDEN", message } = {}) {
  return (req, _res, next) => {
    // must be authenticated
    if (!req.auth?.userId) return forbidden(next, req, "AUTH_REQUIRED", "Authentication required");

    const set = buildPermissionSet(req);

    // optional policy: admin allow all (even without "*")
    if (ADMIN_ALLOW_ALL) {
      const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
      if (roles.map((r) => String(r).toLowerCase()).includes("admin")) return next();
      if (roles.map((r) => String(r).toLowerCase()).includes("superadmin")) return next();
    }

    if (!hasPermission(set, permission)) {
      return forbidden(next, req, code, message || `Missing permission: ${permission}`);
    }

    next();
  };
}

export function requireAnyPermission(permissions, { code = "FORBIDDEN", message } = {}) {
  const list = Array.isArray(permissions) ? permissions : [];
  return (req, _res, next) => {
    if (!req.auth?.userId) return forbidden(next, req, "AUTH_REQUIRED", "Authentication required");

    const set = buildPermissionSet(req);

    if (ADMIN_ALLOW_ALL) {
      const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
      const lower = roles.map((r) => String(r).toLowerCase());
      if (lower.includes("admin") || lower.includes("superadmin")) return next();
    }

    const ok = list.some((p) => hasPermission(set, p));
    if (!ok) return forbidden(next, req, code, message || "Missing required permission");
    next();
  };
}

export function requireAllPermissions(permissions, { code = "FORBIDDEN", message } = {}) {
  const list = Array.isArray(permissions) ? permissions : [];
  return (req, _res, next) => {
    if (!req.auth?.userId) return forbidden(next, req, "AUTH_REQUIRED", "Authentication required");

    const set = buildPermissionSet(req);

    if (ADMIN_ALLOW_ALL) {
      const roles = Array.isArray(req.auth?.roles) ? req.auth.roles : [];
      const lower = roles.map((r) => String(r).toLowerCase());
      if (lower.includes("admin") || lower.includes("superadmin")) return next();
    }

    const ok = list.every((p) => hasPermission(set, p));
    if (!ok) return forbidden(next, req, code, message || "Missing required permissions");
    next();
  };
}

/**
 * Optional helper for controllers/services (if you prefer checks there too)
 */
export function getPermissions(req) {
  return buildPermissionSet(req);
}
