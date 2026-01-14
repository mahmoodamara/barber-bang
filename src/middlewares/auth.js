// src/middlewares/auth.js
import { ENV } from "../utils/env.js";
import { User } from "../models/User.js";
import { UserRoles } from "../models/User.js";
import { verifyAccessToken } from "../utils/authTokens.js";

/**
 * Auth middleware (Access Token):
 * - Verifies JWT (verifyAccessToken must enforce issuer/audience + secret rotation if configured)
 * - Enforces user.isActive
 * - Enforces tokenVersion (payload vs DB)
 * - Uses small in-memory cache (TTL) to reduce DB reads
 */

const AUTH_CACHE_TTL_MS = (() => {
  const raw = Number(ENV.AUTH_CACHE_TTL_MS || 60_000);
  if (!Number.isFinite(raw)) return 60_000;
  return Math.min(120_000, Math.max(30_000, raw));
})();

const AUTH_CACHE_MAX_ENTRIES = 10_000;
const authCache = new Map(); // userId -> { value, expiresAt }

function makeAuthError(code, statusCode = 401) {
  const err = new Error(code); // keep message as machine-code to match existing errorHandler behavior
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function pruneAuthCache(now = Date.now()) {
  for (const [key, entry] of authCache.entries()) {
    if (entry.expiresAt <= now) authCache.delete(key);
  }
  if (authCache.size <= AUTH_CACHE_MAX_ENTRIES) return;

  let extra = authCache.size - AUTH_CACHE_MAX_ENTRIES;
  for (const key of authCache.keys()) {
    authCache.delete(key);
    extra -= 1;
    if (extra <= 0) break;
  }
}

function getCachedAuth(userId) {
  const entry = authCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    authCache.delete(userId);
    return null;
  }
  return entry.value;
}

function setCachedAuth(userId, value) {
  authCache.set(String(userId), { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  if (authCache.size > AUTH_CACHE_MAX_ENTRIES) pruneAuthCache();
}

function getTokenFromReq(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const [type, token] = h.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles.filter((r) => typeof r === "string" && r.length > 0);
}

function normalizePermissions(perms) {
  if (!Array.isArray(perms)) return [];
  const out = [];
  const seen = new Set();
  for (const p of perms) {
    if (typeof p !== "string") continue;
    const v = p.trim();
    if (!v) continue;
    if (v.length > 80) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 200) break;
  }
  return out;
}

export async function requireAuth(req, _res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next(makeAuthError("AUTH_REQUIRED", 401));

  try {
    const payload = verifyAccessToken(token);
    if (!payload || typeof payload !== "object") return next(makeAuthError("AUTH_INVALID", 401));

    const userId = String(payload.sub || "");
    if (!userId) return next(makeAuthError("AUTH_INVALID", 401));

    const tokenVersionRaw = payload.tokenVersion ?? payload.tv ?? 0;
    const tokenVersion = Number(tokenVersionRaw);
    if (!Number.isFinite(tokenVersion) || tokenVersion < 0) return next(makeAuthError("AUTH_INVALID", 401));

    const cached = getCachedAuth(userId);
    if (cached) {
      if (cached.isActive === false) return next(makeAuthError("AUTH_INVALID", 401));

      const cachedVersion = Number(cached.tokenVersion || 0);
      if (Number.isFinite(cachedVersion)) {
        // Fast-path: exact version match
        if (tokenVersion === cachedVersion) {
          req.auth = {
            userId,
            roles: normalizeRoles(cached.roles).length ? normalizeRoles(cached.roles) : ["user"],
            permissions: normalizePermissions(cached.permissions),
            email: cached.emailLower || payload.email,
          };
          return next();
        }

        // If tokenVersion is older than what we already know, fail closed
        if (tokenVersion < cachedVersion) return next(makeAuthError("AUTH_INVALID", 401));
      }
      // If tokenVersion > cachedVersion, fall through to DB to refresh cache (e.g. recent login)
    }

    const user = await User.findById(userId)
      .select("roles permissions isActive tokenVersion emailLower")
      .lean();

    if (!user || !user.isActive) {
      if (user) {
        setCachedAuth(userId, {
          roles: normalizeRoles(user.roles).length ? normalizeRoles(user.roles) : ["user"],
          permissions: normalizePermissions(user.permissions),
          isActive: false,
          tokenVersion: user.tokenVersion || 0,
          emailLower: user.emailLower || null,
        });
      }
      return next(makeAuthError("AUTH_INVALID", 401));
    }

    const userVersion = Number(user.tokenVersion || 0);
    if (!Number.isFinite(userVersion) || userVersion < 0) return next(makeAuthError("AUTH_INVALID", 401));

    // Token version invalidation
    if (tokenVersion !== userVersion) {
      setCachedAuth(userId, {
        roles: normalizeRoles(user.roles).length ? normalizeRoles(user.roles) : ["user"],
        permissions: normalizePermissions(user.permissions),
        isActive: user.isActive,
        tokenVersion: userVersion,
        emailLower: user.emailLower || null,
      });
      return next(makeAuthError("AUTH_INVALID", 401));
    }

    setCachedAuth(userId, {
      roles: normalizeRoles(user.roles).length ? normalizeRoles(user.roles) : ["user"],
      permissions: normalizePermissions(user.permissions),
      isActive: user.isActive,
      tokenVersion: userVersion,
      emailLower: user.emailLower || null,
    });

    req.auth = {
      userId,
      roles: normalizeRoles(user.roles).length ? normalizeRoles(user.roles) : ["user"],
      permissions: normalizePermissions(user.permissions),
      email: user.emailLower || payload.email,
    };

    return next();
  } catch {
    return next(makeAuthError("AUTH_INVALID", 401));
  }
}

/**
 * RBAC helpers
 * - Keep these thin; enforce per-endpoint in routes
 * - Fail closed with FORBIDDEN (403)
 */
export function requireRoleAny(roles) {
  const roleSet = new Set((Array.isArray(roles) ? roles : []).filter(Boolean));
  return (req, _res, next) => {
    const userRoles = normalizeRoles(req.auth?.roles);
    const ok = userRoles.some((r) => roleSet.has(r));
    if (!ok) return next(makeAuthError("FORBIDDEN", 403));
    return next();
  };
}

function hasPermission(userPermissions, requiredPermission) {
  const reqPerm = String(requiredPermission || "").trim();
  if (!reqPerm) return false;
  const list = normalizePermissions(userPermissions);

  // Global wildcard
  if (list.includes("*")) return true;

  // Exact match
  if (list.includes(reqPerm)) return true;

  // Prefix wildcard: orders.* matches orders.read
  const dot = reqPerm.indexOf(".");
  const prefix = dot === -1 ? reqPerm : reqPerm.slice(0, dot);
  if (prefix && list.includes(`${prefix}.*`)) return true;

  // Multi-segment wildcard: orders.payment.* matches orders.payment.resolve
  const parts = reqPerm.split(".");
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const pfx = parts.slice(0, i).join(".");
    if (list.includes(`${pfx}.*`)) return true;
  }

  return false;
}

/**
 * Permission-based guard (RBAC v2)
 *
 * Rules:
 * - role=admin => always allowed (defense-in-depth)
 * - otherwise, require at least one of the permissions
 */
export function requirePermissionAny(permissions) {
  const required = (Array.isArray(permissions) ? permissions : [permissions]).filter(Boolean);
  return (req, _res, next) => {
    const roles = normalizeRoles(req.auth?.roles);
    if (roles.includes("admin")) return next();

    const userPerms = normalizePermissions(req.auth?.permissions);
    const ok = required.some((p) => hasPermission(userPerms, p));
    if (!ok) return next(makeAuthError("FORBIDDEN", 403));
    return next();
  };
}

/**
 * Convenience guards (use only if you already have these roles in UserRoles)
 * - If you don't have SUPER_ADMIN yet, keep it unused until you add it.
 */
export const requireAdmin = (req, res, next) =>
  requireRoleAny([UserRoles.ADMIN])(req, res, next);

export const requireAdminOrStaff = (req, res, next) =>
  requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF])(req, res, next);

// Optional (only if you add UserRoles.SUPER_ADMIN in your model):
export const requireSuperAdmin = (req, res, next) =>
  requireRoleAny([UserRoles.SUPER_ADMIN])(req, res, next);
