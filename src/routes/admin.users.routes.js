// src/routes/admin.users.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { User } from "../models/User.js";
import { Order } from "../models/Order.js";
import { requireAuth, requireRole, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { mapOrder } from "../utils/mapOrder.js";
import { sendOk, sendError } from "../utils/response.js";
import { sendB2BApprovalEmail, sendB2BRejectionEmail } from "../services/email.service.js";
import { recalculateTotalSpent } from "../services/tierProgression.service.js";

const router = express.Router();

router.use(requireAuth());
router.use(requireRole("admin"));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonRes(res, data, meta = null) {
  return sendOk(res, data, meta);
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message);
}

function mapUser(u) {
  const obj = typeof u.toObject === "function" ? u.toObject() : { ...u };
  return {
    id: obj._id,
    _id: obj._id,
    name: obj.name || "",
    email: obj.email || "",
    role: obj.role || "user",
    permissions: Array.isArray(obj.permissions) ? obj.permissions : [],
    isBlocked: Boolean(obj.isBlocked),
    blockedAt: obj.blockedAt || null,
    blockedReason: obj.blockedReason || "",
    tokenVersion: obj.tokenVersion || 0,
    // B2B / Wholesale fields
    accountType: obj.accountType || "individual",
    businessName: obj.businessName || "",
    businessId: obj.businessId || "",
    taxId: obj.taxId || "",
    wholesaleTier: obj.wholesaleTier || "none",
    b2bApproved: Boolean(obj.b2bApproved),
    b2bAppliedAt: obj.b2bAppliedAt || null,
    b2bApprovedAt: obj.b2bApprovedAt || null,
    b2bRejectedAt: obj.b2bRejectedAt || null,
    totalB2BSpent: obj.totalB2BSpent || 0,
    tierLockedByAdmin: Boolean(obj.tierLockedByAdmin),
    creditLimit: obj.creditLimit || 0,
    creditTermDays: obj.creditTermDays || 0,
    creditBalance: obj.creditBalance || 0,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/* ============================
   Schemas
============================ */

const VALID_ROLES = ["user", "admin", "staff"];

const VALID_B2B_STATUSES = ["pending", "approved", "rejected", "all"];

const listQuerySchema = z.object({
  query: z
    .object({
      q: z.string().max(120).optional(),
      role: z.enum(VALID_ROLES).optional(),
      isBlocked: z.enum(["true", "false"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

const b2bListQuerySchema = z.object({
  query: z
    .object({
      q: z.string().max(120).optional(),
      status: z.enum(["pending", "approved", "rejected", "all"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

const b2bModerationSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      action: z.enum(["approve", "reject"]),
      wholesaleTier: z.enum(["bronze", "silver", "gold"]).optional(),
      note: z.string().max(400).optional(),
      creditLimit: z.number().min(0).optional(),
      creditTermDays: z.number().int().min(0).max(180).optional(),
      tierLockedByAdmin: z.boolean().optional(),
    })
    .strict()
    .refine(
      (d) => !(d.action === "approve" && !d.wholesaleTier),
      { message: "wholesaleTier is required when approving", path: ["wholesaleTier"] }
    ),
});

const roleUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      role: z.enum(VALID_ROLES),
    })
    .strict(),
});

const blockUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      isBlocked: z.boolean(),
      reason: z.string().max(400).optional(),
    })
    .strict(),
});

const logoutAllSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

const userOrdersSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: z
    .object({
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

// Strict allowlist of valid permissions
const VALID_PERMISSIONS = Object.values(PERMISSIONS);

const permissionsUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      permissions: z
        .array(z.enum(VALID_PERMISSIONS))
        .max(VALID_PERMISSIONS.length),
    })
    .strict(),
});

/* ============================
   GET /api/admin/users
============================ */

router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.role) {
      filter.role = q.role;
    }

    if (q.isBlocked === "true") {
      filter.isBlocked = true;
    } else if (q.isBlocked === "false") {
      filter.isBlocked = { $ne: true };
    }

    // Search by name or email
    if (q.q) {
      const search = String(q.q).trim().slice(0, 120);
      if (search) {
        const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
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

    const mapped = items.map(mapUser);

    return jsonRes(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/admin/users/b2b
   List B2B applicants/accounts
   NOTE: Must be before /:id to avoid "b2b" being parsed as an ObjectId
============================ */

router.get("/b2b", validate(b2bListQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const status = q.status || "pending";
    let filter = {};

    if (status === "pending") {
      filter = { b2bAppliedAt: { $ne: null }, b2bApproved: { $ne: true }, b2bRejectedAt: null };
    } else if (status === "approved") {
      filter = { b2bApproved: true };
    } else if (status === "rejected") {
      filter = { b2bRejectedAt: { $ne: null }, b2bApproved: { $ne: true } };
    } else {
      filter = {
        $or: [
          { b2bAppliedAt: { $ne: null } },
          { accountType: "business" },
          { b2bApproved: true },
        ],
      };
    }

    if (q.q) {
      const search = String(q.q).trim().slice(0, 120);
      if (search) {
        const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const searchCondition = { $or: [{ name: regex }, { email: regex }, { businessName: regex }] };
        filter = { $and: [filter, searchCondition] };
      }
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .select("-passwordHash -cart -wishlist")
        .sort({ b2bAppliedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const mapped = items.map(mapUser);

    return jsonRes(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/admin/users/:id
============================ */

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const item = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    // Get order stats
    const [orderCount, totalSpent] = await Promise.all([
      Order.countDocuments({ userId: id }),
      Order.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(id), status: { $nin: ["cancelled", "refunded"] } } },
        { $group: { _id: null, total: { $sum: "$pricing.total" } } },
      ]),
    ]);

    const userData = mapUser(item);
    userData.stats = {
      orderCount,
      totalSpent: totalSpent[0]?.total || 0,
    };

    return jsonRes(res, userData);
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/users/:id/role
============================ */

router.patch("/:id/role", validate(roleUpdateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const { role } = req.validated.body;

    // Prevent admin from demoting themselves
    if (String(req.user._id) === id && role !== "admin") {
      throw makeErr(400, "CANNOT_DEMOTE_SELF", "You cannot change your own admin role");
    }

    const user = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!user) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    // If promoting to admin, invalidate existing tokens for security
    if (role === "admin" && user.role !== "admin") {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    user.role = role;
    await user.save();

    return jsonRes(res, mapUser(user));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/users/:id/block
============================ */

router.patch("/:id/block", validate(blockUpdateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const { isBlocked, reason } = req.validated.body;

    // Prevent admin from blocking themselves
    if (String(req.user._id) === id) {
      throw makeErr(400, "CANNOT_BLOCK_SELF", "You cannot block yourself");
    }

    const user = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!user) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    // Prevent blocking other admins (security measure)
    if (user.role === "admin" && isBlocked) {
      throw makeErr(400, "CANNOT_BLOCK_ADMIN", "Cannot block admin users");
    }

    user.isBlocked = isBlocked;

    if (isBlocked) {
      user.blockedAt = new Date();
      user.blockedReason = reason || "";
      // Invalidate all tokens when blocking
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    } else {
      user.blockedAt = null;
      user.blockedReason = "";
    }

    await user.save();

    return jsonRes(res, mapUser(user));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/users/:id/logout-all
============================ */

router.post("/:id/logout-all", validate(logoutAllSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const user = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!user) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    // Increment tokenVersion to invalidate all existing tokens
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return jsonRes(res, {
      userId: user._id,
      tokenVersion: user.tokenVersion,
      message: "All user sessions have been invalidated",
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/admin/users/:id/orders
============================ */

router.get("/:id/orders", validate(userOrdersSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const q = req.validated.query || {};
    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    // Verify user exists
    const userExists = await User.exists({ _id: id });
    if (!userExists) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const filter = { userId: id };

    const [items, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    const mapped = items.map((o) => mapOrder(o, { lang: req.lang }));

    return jsonRes(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/users/:id/permissions
   Update staff user permissions
============================ */

router.patch("/:id/permissions", validate(permissionsUpdateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const { permissions } = req.validated.body;

    // Prevent admin from modifying their own permissions
    if (String(req.user._id) === id) {
      throw makeErr(400, "CANNOT_MODIFY_SELF", "You cannot modify your own permissions");
    }

    const user = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!user) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    // Only staff users can have permissions modified
    // Admins have all permissions implicitly, regular users cannot have admin permissions
    if (user.role !== "staff") {
      throw makeErr(400, "INVALID_ROLE", "Permissions can only be assigned to staff users");
    }

    // Deduplicate and validate permissions against strict allowlist
    const validPermissions = [...new Set(permissions)].filter((p) =>
      VALID_PERMISSIONS.includes(p)
    );

    user.permissions = validPermissions;

    // Invalidate tokens when permissions change (security measure)
    user.tokenVersion = (user.tokenVersion || 0) + 1;

    await user.save();

    return jsonRes(res, {
      ...mapUser(user),
      permissions: user.permissions,
      message: "Permissions updated. User will need to re-authenticate.",
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/users/:id/b2b
   Approve or reject a B2B application
============================ */

router.patch("/:id/b2b", validate(b2bModerationSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const { action, wholesaleTier, creditLimit, creditTermDays, tierLockedByAdmin } = req.validated.body;

    const user = await User.findById(id).select("-passwordHash -cart -wishlist");
    if (!user) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    if (!user.b2bAppliedAt && action === "approve") {
      throw makeErr(400, "NO_B2B_APPLICATION", "User has not submitted a B2B application");
    }

    if (action === "approve") {
      user.b2bApproved = true;
      user.b2bApprovedAt = new Date();
      user.wholesaleTier = wholesaleTier;
      user.accountType = "business";
      if (creditLimit != null) user.creditLimit = creditLimit;
      if (creditTermDays != null) user.creditTermDays = creditTermDays;
      if (tierLockedByAdmin != null) user.tierLockedByAdmin = tierLockedByAdmin;
      user.b2bRejectedAt = null;
    } else {
      // reject
      user.b2bApproved = false;
      user.b2bApprovedAt = null;
      user.wholesaleTier = "none";
      user.b2bRejectedAt = new Date();
    }

    await user.save();

    // Send email notification (best-effort, never blocks response)
    const emailTo = String(user.email || "").trim().toLowerCase();
    if (emailTo) {
      const lang = req.query?.lang === "ar" ? "ar" : "he";
      const bName = user.businessName || user.name || "";
      if (action === "approve") {
        sendB2BApprovalEmail(emailTo, { businessName: bName, wholesaleTier }, lang).catch(() => {});
      } else {
        sendB2BRejectionEmail(emailTo, { businessName: bName }, lang).catch(() => {});
      }
    }

    return jsonRes(res, mapUser(user));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/admin/users/:id/custom-pricing
   Retrieve a user's custom price list
============================ */
router.get("/:id/custom-pricing", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }

    const user = await User.findById(id)
      .select("customPricing businessName name email wholesaleTier")
      .populate("customPricing.productId", "titleHe titleAr sku price")
      .lean();
    if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");

    return jsonRes(res, {
      userId: user._id,
      businessName: user.businessName || user.name || "",
      wholesaleTier: user.wholesaleTier || "none",
      customPricing: (user.customPricing || []).map((cp) => ({
        productId: cp.productId?._id || cp.productId,
        titleHe: cp.productId?.titleHe || "",
        titleAr: cp.productId?.titleAr || "",
        sku: cp.productId?.sku || "",
        retailPrice: cp.productId?.price || 0,
        customPrice: cp.price,
      })),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PUT /api/admin/users/:id/custom-pricing
   Replace a user's entire custom price list
============================ */
const customPricingBodySchema = z.object({
  body: z.object({
    customPricing: z
      .array(
        z.object({
          productId: z.string().min(1),
          price: z.number().min(0),
        }),
      )
      .max(500),
  }),
});

router.put(
  "/:id/custom-pricing",
  validate(customPricingBodySchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return safeNotFound(res, "NOT_FOUND", "User not found");
      }

      const user = await User.findById(id).select(
        "customPricing b2bApproved businessName name wholesaleTier",
      );
      if (!user) return safeNotFound(res, "NOT_FOUND", "User not found");
      if (!user.b2bApproved) {
        throw makeErr(
          400,
          "NOT_B2B",
          "Custom pricing is only available for approved B2B users",
        );
      }

      user.customPricing = req.validated.body.customPricing.map((cp) => ({
        productId: cp.productId,
        price: cp.price,
      }));
      await user.save();

      return jsonRes(res, {
        userId: user._id,
        count: user.customPricing.length,
      });
    } catch (e) {
      return jsonErr(res, e);
    }
  },
);

/* ============================
   POST /api/admin/users/:id/recalculate-spent
   Recalculate totalB2BSpent from order history
============================ */
router.post("/:id/recalculate-spent", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "User not found");
    }
    const total = await recalculateTotalSpent(id);
    return jsonRes(res, { userId: id, totalB2BSpent: total });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
