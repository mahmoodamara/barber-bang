// src/routes/admin.reviews.routes.js
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
import { getRequestId } from "../middleware/error.js";

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

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonErr(req, res, e, fallback = { code: "INTERNAL_ERROR", message: "Unexpected error" }) {
  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || fallback.code,
    e?.message || fallback.message,
    {
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    }
  );
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

function safeNotFound(req, res, code = "NOT_FOUND", message = "Review not found") {
  return sendError(res, 404, code, message, {
    requestId: getRequestId(req),
    path: req.originalUrl || req.url || "",
  });
}

const objectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid id" });

function clampPage(v) {
  return Math.max(1, Number(v || 1));
}
function clampLimit(v) {
  return Math.min(100, Math.max(1, Number(v || 20)));
}

/* ============================
   Schemas
============================ */

const listQuerySchema = z.object({
  query: z
    .object({
      // allow UI-only lang/locale in case it reaches here (defense in depth)
      lang: z.string().optional(),
      locale: z.string().optional(),

      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),

      productId: objectIdSchema.optional(),
      userId: objectIdSchema.optional(),

      status: z.enum(["approved", "pending", "rejected"]).optional(),
      isHidden: z.enum(["true", "false"]).optional(),
      rating: z.enum(["1", "2", "3", "4", "5"]).optional(),

      // optional free text search (review fields + ids)
      q: z.string().max(120).optional(),

      // ISO date-time (query strings)
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),

      // safe sorting allowlist
      sortBy: z.enum(["createdAt", "updatedAt", "rating", "moderationStatus", "isHidden"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    })
    .strict()
    .optional(),
});

const updateSchema = z.object({
  params: z.object({ id: objectIdSchema }).strict(),
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

    const page = clampPage(q.page);
    const limit = clampLimit(q.limit);
    const skip = (page - 1) * limit;

    const filter = {};

    // exact filters
    if (q.productId) filter.productId = q.productId;
    if (q.userId) filter.userId = q.userId;
    if (q.status) filter.moderationStatus = q.status;
    if (q.isHidden) filter.isHidden = q.isHidden === "true";
    if (q.rating) filter.rating = Number(q.rating);

    // date range
    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) filter.createdAt.$gte = new Date(q.dateFrom);
      if (q.dateTo) filter.createdAt.$lte = new Date(q.dateTo);
    }

    // free text search (no aggregation/lookup; searches Review fields + ids)
    if (q.q) {
      const term = String(q.q).trim().slice(0, 120);
      if (term) {
        const or = [];
        if (isValidObjectId(term)) {
          // allow searching by review id, product id, user id
          or.push({ _id: term }, { productId: term }, { userId: term });
        } else {
          const rx = new RegExp(escapeRegex(term), "i");
          // include a safe superset of possible schema fields
          or.push(
            { title: rx },
            { comment: rx },
            { text: rx },
            { body: rx },
            { moderationNote: rx }
          );
        }
        if (or.length) filter.$or = or;
      }
    }

    // sort allowlist (default createdAt desc)
    let sort = { createdAt: -1 };
    if (q.sortBy) {
      const dir = q.sortDir === "asc" ? 1 : -1;
      sort = { [q.sortBy]: dir };
    }

    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        // keep populate minimal for list performance
        .populate("productId", "name slug mainImage imageUrl")
        .populate("userId", "name email")
        .populate("moderatedBy", "name")
        .lean(),
      Review.countDocuments(filter),
    ]);

    // defense-in-depth output sanitization to reduce stored-XSS risk
    const safeItems = (items || []).map(sanitizeReviewOutput);

    return sendOk(res, safeItems, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    // do not leak internal error messages
    return jsonErr(req, res, e, { code: "INTERNAL_ERROR", message: "Failed to load reviews" });
  }
});

/* ============================
   GET /api/v1/admin/reviews/:id
============================ */
router.get(
  "/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }).strict() })),
  async (req, res) => {
    try {
      const id = String(req.validated.params.id);

      const item = await Review.findById(id)
        .populate("productId", "name slug mainImage imageUrl")
        .populate("userId", "name email")
        .populate("moderatedBy", "name")
        .lean();

      if (!item) return safeNotFound(req, res);

      return sendOk(res, sanitizeReviewOutput(item));
    } catch (e) {
      return jsonErr(req, res, e, { code: "INTERNAL_ERROR", message: "Failed to load review" });
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

    // Reject empty patch to avoid useless updates + unnecessary recalculation
    if (isHidden === undefined && moderationStatus === undefined && moderationNote === undefined) {
      return sendError(res, 400, "NO_CHANGES", "No changes provided", {
        requestId: getRequestId(req),
        path: req.originalUrl || req.url || "",
      });
    }

    // Load before to decide if stats should be recalculated
    const before = await Review.findById(id).select("productId isHidden moderationStatus").lean();
    if (!before) return safeNotFound(req, res);

    const update = {};

    if (isHidden !== undefined) update.isHidden = isHidden;
    if (moderationStatus !== undefined) update.moderationStatus = moderationStatus;

    // sanitize moderation note (admin input can still be abused)
    if (moderationNote !== undefined) update.moderationNote = sanitizePlainText(moderationNote);

    // Track who moderated (only when there is an actual moderation-related change)
    const touchedModeration = isHidden !== undefined || moderationStatus !== undefined || moderationNote !== undefined;
    if (touchedModeration) {
      update.moderatedBy = req.user?._id;
      update.moderatedAt = new Date();
    }

    const item = await Review.findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .populate("productId", "name")
      .populate("userId", "name")
      .populate("moderatedBy", "name")
      .lean();

    if (!item) return safeNotFound(req, res);

    // Recalculate stats only if fields affecting visibility/counting changed
    const affectsStats =
      (isHidden !== undefined && Boolean(isHidden) !== Boolean(before.isHidden)) ||
      (moderationStatus !== undefined && String(moderationStatus) !== String(before.moderationStatus));

    if (affectsStats) {
      const pid = item.productId?._id || item.productId || before.productId;
      await recalculateProductRatingStats(pid).catch(() => {});
    }

    return sendOk(res, sanitizeReviewOutput(item));
  } catch (e) {
    return jsonErr(req, res, e, { code: "INTERNAL_ERROR", message: "Failed to update review" });
  }
});

/* ============================
   DELETE /api/v1/admin/reviews/:id
============================ */
router.delete(
  "/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }).strict() })),
  async (req, res) => {
    try {
      const id = String(req.validated.params.id);

      const item = await Review.findByIdAndDelete(id).lean();
      if (!item) return safeNotFound(req, res);

      await recalculateProductRatingStats(item.productId).catch(() => {});

      return sendOk(res, { deleted: true, id });
    } catch (e) {
      return jsonErr(req, res, e, { code: "INTERNAL_ERROR", message: "Failed to delete review" });
    }
  }
);

export default router;
