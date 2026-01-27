// src/routes/reviews.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Review } from "../models/Review.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = express.Router();

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

const deleteSchema = z.object({
  params: z.object({
    id: z.string().min(1),
  }),
});

/**
 * DELETE /api/reviews/:id
 * Protected
 * Allow: owner OR admin/staff
 *
 * Security:
 * - user tries to delete someone else's review -> return 404 (no leak)
 * - admin/staff can delete any review
 */
router.delete("/:id", requireAuth(), validate(deleteSchema), async (req, res, next) => {
  try {
    const id = String(req.params.id || "");

    if (!isValidObjectId(id)) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Review not found" },
      });
    }

    const role = req.user?.role || "user";

    // ✅ Admin/staff: can delete any review
    if (role === "admin" || role === "staff") {
      const deleted = await Review.findByIdAndDelete(id).lean();

      if (!deleted) {
        return res.status(404).json({
          ok: false,
          error: { code: "NOT_FOUND", message: "Review not found" },
        });
      }

      return res.json({ ok: true, data: { deleted: true } });
    }

    // ✅ Normal user: can delete ONLY their own review
    const result = await Review.deleteOne({ _id: id, userId: req.user._id });

    // If not found (or not owned) => 404 (no leak)
    if (result.deletedCount !== 1) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Review not found" },
      });
    }

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return next(e);
  }
});

export default router;
