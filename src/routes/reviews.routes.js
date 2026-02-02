// src/routes/reviews.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Review } from "../models/Review.js";
import { Product } from "../models/Product.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { recalculateProductRatingStats } from "../services/ranking.service.js";

const router = express.Router();

function errorPayload(req, code, message) {
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

function okPayload(data = {}) {
  return { ok: true, success: true, data };
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

const objectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid id" });

const createSchema = z.object({
  body: z.object({
    productId: objectIdSchema,
    rating: z.number().int().min(1).max(5),
    content: z.string().max(600).optional(),
    comment: z.string().max(600).optional(),
  }),
});

const deleteSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

/**
 * POST /api/v1/reviews
 * Protected (requireAuth at mount).
 * Body: { productId, rating, content? | comment? }
 */
router.post("/", validate(createSchema), async (req, res) => {
  try {
    const { productId, rating, content, comment } = req.validated.body;
    const text = (comment ?? content ?? "").trim().slice(0, 600);

    const product = await Product.findOne({
      _id: productId,
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select("_id")
      .lean();
    if (!product) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Product not found"));
    }

    const updated = await Review.findOneAndUpdate(
      { productId, userId: req.user._id },
      { $set: { rating, comment: text } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    await recalculateProductRatingStats(updated.productId).catch(() => {});

    return res.status(201).json(
      okPayload({
        id: updated._id,
        _id: updated._id,
        productId: updated.productId,
        userId: updated.userId,
        rating: updated.rating,
        comment: updated.comment || "",
        createdAt: updated.createdAt,
      })
    );
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json(errorPayload(req, "DUPLICATE", "Review already exists"));
    }
    return res.status(500).json(errorPayload(req, "INTERNAL_ERROR", "Failed to create review"));
  }
});

/**
 * DELETE /api/reviews/:id
 * Protected
 * Allow:
 * - owner can delete ONLY their own review
 * - admin/staff can delete any review
 *
 * Security:
 * - user tries to delete someone else's review -> return 404 (no leak)
 * - invalid id -> 404 (no leak)
 */
router.delete("/:id", requireAuth(), validate(deleteSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id);

    const role = req.user?.role || "user";

    // ✅ Admin/Staff: can delete any review
    if (role === "admin" || role === "staff") {
      const deleted = await Review.findByIdAndDelete(id).lean();

      if (!deleted) {
        return res
          .status(404)
          .json(errorPayload(req, "NOT_FOUND", "Review not found"));
      }

      await recalculateProductRatingStats(deleted.productId).catch(() => {});

      return res.json(okPayload({ deleted: true }));
    }

    // ✅ Normal user: delete ONLY their own review
    const deleted = await Review.findOneAndDelete({ _id: id, userId: req.user._id }).lean();

    // Not found or not owned => 404 (no leak)
    if (!deleted) {
      return res
        .status(404)
        .json(errorPayload(req, "NOT_FOUND", "Review not found"));
    }

    await recalculateProductRatingStats(deleted.productId).catch(() => {});

    return res.json(okPayload({ deleted: true }));
  } catch (e) {
    // Keep errors consistent (avoid leaking details)
    return res
      .status(500)
      .json(errorPayload(req, "INTERNAL_ERROR", "Failed to delete review"));
  }
});

export default router;
