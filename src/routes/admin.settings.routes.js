// src/routes/admin.users.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";
import { mapOrder } from "../utils/mapOrder.js";

const router = express.Router();

/* ============================
   Global Guards
============================ */

// Prefer permission-based access (enterprise-grade).
// If you still want "admin-only", keep requireRole("admin") instead.
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.USERS_WRITE ?? PERMISSIONS.SETTINGS_WRITE)); // fallback if USERS_WRITE doesn't exist
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

function makeErr(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error",
    e.details ? { details: e.details } : undefined
  );
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message);
}

const asyncHandler =
  (fn) =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      return jsonErr(res, e);
    }
  };

function requireObjectIdParam(paramName, code = "INVALID_ID", message = "Invalid id") {
  return (req, _res, next) => {
    const id = String(req.params?.[paramName] || "");
    if (!isValidObjectId(id)) return next(makeErr(404, "NOT_FOUND", message));
    return next();
  };
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapUser(u) {
  const obj = typeof u?.toObject === "function" ? u.toObject() : { ...u };
  return {
    id: obj._id,
    _id: obj._id, // legacy compatibility
    name: obj.name || "",
    email: obj.email || "",
    role: obj.role || "user",
    permissions: Array.isArray(obj.permissions) ? obj.permissions : [],
    isBlocked: Boolean(obj.isBlocked),
    blockedAt: obj.blockedAt || null,
    blockedReason: obj.blockedReason || "",
    tokenVersion: obj.tokenVersion || 0,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/* ============================
   Schemas
============================ */

const VALID_ROLES = ["user", "admin", "staff"];

const objectIdParamSchema = z.object({ id: z.string().min(1) }).strict();

const listQuerySchema = z.object({
  query: z
    .object({
      q: z.string().max(120).optional(),
      role: z.enum(VALID_ROLES).optional(),
      isBlocked: z.enum(["true", "false"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .optional(),
});

const roleUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      role: z.enum(VALID_ROLES),
    })
    .strict(),
});

const blockUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      isBlocked: z.boolean(),
      reason: z.string().max(400).optional(),
    })
    .strict(),
});

const logoutAllSchema = z.object({
  params: objectIdParamSchema,
});

const userOrdersSchema = z.object({
  params: objectIdParamSchema,
  query: z
    .object({
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .optional(),
});

// Strict allowlist of valid permissions
const VALID_PERMISSIONS = Object.values(PERMISSIONS);

const permissionsUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      permissions: z.array(z.enum(VALID_PERMISSIONS)).max(VALID_PERMISSIONS.length),
    })
    .strict(),
});

/* ============================
   GET /api/admin/users
============================ */

router.get(
  "/",
  validate(listQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.role) filter.role = q.role;

    if (q.isBlocked === "true") filter.isBlocked = true;
    else if (q.isBlocked === "false") filter.isBlocked = { $ne: true };

    // Search by name or email (escaped regex)
    if (q.q) {
      const search = String(q.q).trim().slice(0, 120);
      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ name: regex }, { email: regex }];
      }
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .select("-passwordHash -cart -wishlist")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return sendOk(res, items.map(mapUser), {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  })
);

/* ============================
   GET /api/admin/users/:id
============================ */

router.get(
  "/:id",
  validate(z.object({ params: objectIdParamSchema }).strict()),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);

    const user = await User.findById(oid).select("-passwordHash -cart -wishlist").lean();
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    // Order stats (use ObjectId consistently)
    const [orderCount, totalSpentAgg] = await Promise.all([
      Order.countDocuments({ userId: oid }),
      Order.aggregate([
        { $match: { userId: oid, status: { $nin: ["cancelled", "refunded"] } } },
        { $group: { _id: null, total: { $sum: "$pricing.total" } } },
      ]),
    ]);

    const userData = mapUser(user);
    userData.stats = {
      orderCount,
      totalSpent: totalSpentAgg?.[0]?.total || 0,
    };

    return sendOk(res, userData);
  })
);

/* ============================
   PATCH /api/admin/users/:id/role
============================ */

router.patch(
  "/:id/role",
  validate(roleUpdateSchema),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);
    const { role } = req.validated.body;

    // Prevent admin from demoting themselves
    if (String(req.user?._id) === id && role !== "admin") {
      throw makeErr(400, "CANNOT_DEMOTE_SELF", "You cannot change your own admin role");
    }

    const user = await User.findById(oid).select("-passwordHash -cart -wishlist");
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    // If promoting to admin, invalidate existing tokens for security
    if (role === "admin" && user.role !== "admin") {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    user.role = role;
    await user.save();

    return sendOk(res, mapUser(user));
  })
);

/* ============================
   PATCH /api/admin/users/:id/block
============================ */

router.patch(
  "/:id/block",
  validate(blockUpdateSchema),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);
    const { isBlocked, reason } = req.validated.body;

    // Prevent admin from blocking themselves
    if (String(req.user?._id) === id) {
      throw makeErr(400, "CANNOT_BLOCK_SELF", "You cannot block yourself");
    }

    const user = await User.findById(oid).select("-passwordHash -cart -wishlist");
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    // Prevent blocking other admins (security measure)
    if (user.role === "admin" && isBlocked) {
      throw makeErr(400, "CANNOT_BLOCK_ADMIN", "Cannot block admin users");
    }

    user.isBlocked = isBlocked;

    if (isBlocked) {
      user.blockedAt = new Date();
      user.blockedReason = String(reason || "").slice(0, 400);
      user.tokenVersion = (user.tokenVersion || 0) + 1; // invalidate tokens
    } else {
      user.blockedAt = null;
      user.blockedReason = "";
    }

    await user.save();

    return sendOk(res, mapUser(user));
  })
);

/* ============================
   POST /api/admin/users/:id/logout-all
============================ */

router.post(
  "/:id/logout-all",
  validate(logoutAllSchema),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);

    // Prevent admin from logging themselves out globally if you want (optional)
    // if (String(req.user?._id) === id) throw makeErr(400, "CANNOT_LOGOUT_SELF", "You cannot logout yourself");

    const user = await User.findById(oid).select("-passwordHash -cart -wishlist");
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return sendOk(res, {
      userId: user._id,
      tokenVersion: user.tokenVersion,
      message: "All user sessions have been invalidated",
    });
  })
);

/* ============================
   GET /api/admin/users/:id/orders
============================ */

router.get(
  "/:id/orders",
  validate(userOrdersSchema),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);

    const q = req.validated.query || {};
    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    // Verify user exists
    const userExists = await User.exists({ _id: oid });
    if (!userExists) return safeNotFound(res, "NOT_FOUND", "User not found");

    const filter = { userId: oid };

    const [items, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    const mapped = items.map((o) => mapOrder(o, { lang: req.lang }));

    return sendOk(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  })
);

/* ============================
   PATCH /api/admin/users/:id/permissions
============================ */

router.patch(
  "/:id/permissions",
  validate(permissionsUpdateSchema),
  requireObjectIdParam("id", "NOT_FOUND", "User not found"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const oid = toObjectId(id);
    const { permissions } = req.validated.body;

    // Prevent admin from modifying their own permissions
    if (String(req.user?._id) === id) {
      throw makeErr(400, "CANNOT_MODIFY_SELF", "You cannot modify your own permissions");
    }

    const user = await User.findById(oid).select("-passwordHash -cart -wishlist");
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    // Only staff users can have permissions modified
    if (user.role !== "staff") {
      throw makeErr(400, "INVALID_ROLE", "Permissions can only be assigned to staff users");
    }

    // Zod already validated, this is defense-in-depth:
    const validPermissions = [...new Set(permissions)].filter((p) =>
      VALID_PERMISSIONS.includes(p)
    );

    user.permissions = validPermissions;
    user.tokenVersion = (user.tokenVersion || 0) + 1; // force re-auth

    await user.save();

    return sendOk(res, {
      ...mapUser(user),
      permissions: user.permissions,
      message: "Permissions updated. User will need to re-authenticate.",
    });
  })
);

export default router;
