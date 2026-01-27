import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Review } from "../models/Review.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";
import { auditAdmin } from "../middleware/audit.js";
import { sanitizePlainText } from "../utils/sanitize.js";
import { recalculateProductRatingStats } from "../services/ranking.service.js";

const router = express.Router();

// Auth: Staff with PRODUCTS_WRITE or Admin
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.PRODUCTS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

/**
 * Defense-in-depth sanitization for review payload.
 * We sanitize the fields that are commonly used in UI rendering.
 */
function sanitizeReviewOutput(item) {
  if (!item || typeof item !== "object") return item;

  const out = { ...item };

  // Common review fields (depending on your schema)
  if (out.comment !== undefined) out.comment = sanitizePlainText(out.comment);
  if (out.text !== undefined) out.text = sanitizePlainText(out.text);
  if (out.body !== undefined) out.body = sanitizePlainText(out.body);
  if (out.title !== undefined) out.title = sanitizePlainText(out.title);

  // Admin moderation note can also be displayed in dashboard
  if (out.moderationNote !== undefined) out.moderationNote = sanitizePlainText(out.moderationNote);

  return out;
}

function safeNotFound(res, code = "NOT_FOUND", message = "Review not found") {
  return sendError(res, 404, code, message);
}

const objectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid id" });

/* ============================
   Schemas
============================ */

const listQuerySchema = z.object({
  query: z
    .object({
      // ✅ allow UI-only lang/locale in case it reaches here (defense in depth)
      lang: z.string().optional(),
      locale: z.string().optional(),

      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),

      productId: objectIdSchema.optional(),
      userId: objectIdSchema.optional(),

      status: z.enum(["approved", "pending", "rejected"]).optional(),
      isHidden: z.enum(["true", "false"]).optional(),
      rating: z.enum(["1", "2", "3", "4", "5"]).optional(),

      // ISO date-time (query strings)
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
    })
    .strict()
    .optional(),
});

const updateSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z
    .object({
      isHidden: z.boolean().optional(),
      moderationStatus: z.enum(["approved", "pending", "rejected"]).optional(),
      moderationNote: z.string().max(500).optional(),
    })
    .strict(),
});

/* ============================
   GET /api/v1/admin/reviews
============================ */
router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};
    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.productId) filter.productId = q.productId;
    if (q.userId) filter.userId = q.userId;
    if (q.status) filter.moderationStatus = q.status;
    if (q.isHidden) filter.isHidden = q.isHidden === "true";
    if (q.rating) filter.rating = Number(q.rating);

    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) filter.createdAt.$gte = new Date(q.dateFrom);
      if (q.dateTo) filter.createdAt.$lte = new Date(q.dateTo);
    }

    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("productId", "name slug images") // Minimal product info
        .populate("userId", "name email") // Minimal user info
        .populate("moderatedBy", "name") // Moderator info
        .lean(),
      Review.countDocuments(filter),
    ]);

    // ✅ Defense-in-depth output sanitization to reduce stored-XSS risk
    const safeItems = (items || []).map(sanitizeReviewOutput);

    return sendOk(res, safeItems, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (_e) {
    // ✅ do not leak internal error messages
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to load reviews");
  }
});

/* ============================
   GET /api/v1/admin/reviews/:id
============================ */
router.get(
  "/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }) })),
  async (req, res) => {
    try {
      const id = String(req.validated.params.id);

      const item = await Review.findById(id)
        .populate("productId", "name slug images")
        .populate("userId", "name email")
        .populate("moderatedBy", "name")
        .lean();

      if (!item) return safeNotFound(res);

      // ✅ Defense-in-depth output sanitization
      return sendOk(res, sanitizeReviewOutput(item));
    } catch (_e) {
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to load review");
    }
  }
);

/* ============================
   PATCH /api/v1/admin/reviews/:id
   Moderation actions
============================ */
router.patch("/:id", validate(updateSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id);
    const { isHidden, moderationStatus, moderationNote } = req.validated.body;

    const update = {};

    if (isHidden !== undefined) update.isHidden = isHidden;
    if (moderationStatus !== undefined) update.moderationStatus = moderationStatus;

    // ✅ sanitize moderation note (admin input can still be abused)
    if (moderationNote !== undefined) update.moderationNote = sanitizePlainText(moderationNote);

    // Track who moderated
    if (Object.keys(update).length > 0) {
      update.moderatedBy = req.user._id;
      update.moderatedAt = new Date();
    }

    const item = await Review.findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .populate("productId", "name")
      .populate("userId", "name")
      .lean();

    if (!item) return safeNotFound(res);

    await recalculateProductRatingStats(item.productId?._id || item.productId).catch(() => {});

    // ✅ sanitize output
    return sendOk(res, sanitizeReviewOutput(item));
  } catch (_e) {
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to update review");
  }
});

/* ============================
   DELETE /api/v1/admin/reviews/:id
============================ */
router.delete(
  "/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }) })),
  async (req, res) => {
    try {
      const id = String(req.validated.params.id);

      const item = await Review.findByIdAndDelete(id).lean();
      if (!item) return safeNotFound(res);

      await recalculateProductRatingStats(item.productId).catch(() => {});

      return sendOk(res, { deleted: true, id });
    } catch (_e) {
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to delete review");
    }
  }
);

export default router;
