import { verifyToken } from "../utils/jwt.js";
import { User } from "../models/User.js";
import { PERMISSIONS } from "../config/permissions.js";
import { getRequestId } from "./error.js";

function authError(req, code, message) {
  return {
    ok: false,
    success: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

/**
 * Extract Bearer token from Authorization header safely.
 * Supports:
 * - "Bearer <token>"
 * - case-insensitive "bearer <token>"
 */
function extractBearerToken(req) {
  const raw = req.headers?.authorization;

  if (!raw || typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value) return null;

  const [scheme, token] = value.split(/\s+/);
  if (!scheme || !token) return null;

  if (scheme.toLowerCase() !== "bearer") return null;

  return token?.trim() || null;
}

function normalizeJwtError(req, e) {
  // verifyToken() in our hardened jwt utils throws normalized errors:
  // err.code = "TOKEN_MISSING" | "TOKEN_INVALID"
  // err.name could be "TokenExpiredError" etc
  const name = e?.name || "";
  const code = e?.code || "";

  if (code === "TOKEN_MISSING") {
    return { status: 401, body: authError(req, "UNAUTHORIZED", "Missing token") };
  }

  // Token expired (same status, clearer message)
  if (name === "TokenExpiredError") {
    return { status: 401, body: authError(req, "UNAUTHORIZED", "Token expired") };
  }

  // Default invalid token
  return { status: 401, body: authError(req, "UNAUTHORIZED", "Invalid token") };
}

export function requireAuth() {
  return async (req, res, next) => {
    try {
      const token = extractBearerToken(req);

      if (!token) {
        return res
          .status(401)
          .json(authError(req, "UNAUTHORIZED", "Missing token"));
      }

      const payload = verifyToken(token);

      // Prefer sub (standard), fallback to userId for backward compatibility
      const userId = payload?.sub || payload?.userId;

      if (!userId) {
        return res
          .status(401)
          .json(authError(req, "UNAUTHORIZED", "Invalid token"));
      }

      // Select only what we need (avoid leaking sensitive fields)
      const user = await User.findById(userId).select(
        "_id name email role tokenVersion isBlocked permissions"
      );

      if (!user) {
        return res
          .status(401)
          .json(authError(req, "UNAUTHORIZED", "User not found"));
      }

      // tokenVersion revocation (logout / security reset)
      if (Number(payload?.tokenVersion || 0) !== Number(user?.tokenVersion || 0)) {
        return res
          .status(401)
          .json(authError(req, "UNAUTHORIZED", "Invalid token"));
      }

      // Blocked user
      if (user.isBlocked) {
        return res
          .status(403)
          .json(authError(req, "USER_BLOCKED", "Your account has been blocked"));
      }

      req.user = user;
      req.auth = {
        sub: String(user._id),
        tokenVersion: Number(user.tokenVersion || 0),
        role: user.role,
      };

      return next();
    } catch (e) {
      const normalized = normalizeJwtError(req, e);
      return res.status(normalized.status).json(normalized.body);
    }
  };
}

export function requireRole(...roles) {
  const allowed = new Set((roles || []).filter(Boolean));

  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json(authError(req, "UNAUTHORIZED", "Not authenticated"));
    }

    if (!allowed.has(req.user.role)) {
      return res
        .status(403)
        .json(authError(req, "FORBIDDEN", "Access denied"));
    }

    return next();
  };
}

export { PERMISSIONS };

/**
 * Check if user has specific permission(s).
 * Admin always has all permissions.
 * Staff must have the permission explicitly granted.
 * @param  {...string} requiredPermissions
 */
export function requirePermission(...requiredPermissions) {
  const required = (requiredPermissions || []).filter(Boolean);

  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json(authError(req, "UNAUTHORIZED", "Not authenticated"));
    }

    // Admin has all permissions
    if (req.user.role === "admin") {
      return next();
    }

    // Staff must have explicit permissions
    if (req.user.role === "staff") {
      const userPermissions = new Set(req.user.permissions || []);
      const hasAll = required.every((p) => userPermissions.has(p));

      if (hasAll) {
        return next();
      }

      return res.status(403).json(
        authError(
          req,
          "INSUFFICIENT_PERMISSIONS",
          `Missing required permission(s): ${required.join(", ")}`
        )
      );
    }

    // Regular users don't have admin permissions
    return res
      .status(403)
      .json(authError(req, "FORBIDDEN", "Access denied"));
  };
}

/**
 * Check if user has any of the specified permissions.
 * Admin always passes.
 * Staff must have at least one of the permissions.
 * @param  {...string} permissions
 */
export function requireAnyPermission(...permissions) {
  const any = (permissions || []).filter(Boolean);

  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json(authError(req, "UNAUTHORIZED", "Not authenticated"));
    }

    // Admin has all permissions
    if (req.user.role === "admin") {
      return next();
    }

    // Staff must have at least one permission
    if (req.user.role === "staff") {
      const userPermissions = new Set(req.user.permissions || []);
      const hasAny = any.some((p) => userPermissions.has(p));

      if (hasAny) {
        return next();
      }

      return res.status(403).json(
        authError(
          req,
          "INSUFFICIENT_PERMISSIONS",
          `Requires one of: ${any.join(", ")}`
        )
      );
    }

    // Regular users don't have admin permissions
    return res
      .status(403)
      .json(authError(req, "FORBIDDEN", "Access denied"));
  };
}
