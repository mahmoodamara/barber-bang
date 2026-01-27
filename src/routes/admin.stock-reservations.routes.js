// src/routes/admin.stock-reservations.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { StockReservation } from "../models/StockReservation.js";
import { releaseStockReservation } from "../services/products.service.js";
import { requireAuth, requireAnyPermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

router.use(requireAuth());
router.use(requireAnyPermission(PERMISSIONS.ORDERS_WRITE, PERMISSIONS.PRODUCTS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function jsonErr(res, e) {
  return sendError(res, e.statusCode || 500, e.code || "INTERNAL_ERROR", e.message || "Unexpected error");
}

/* ============================
   Schemas
============================ */

const listQuerySchema = z.object({
  query: z
    .object({
      // ✅ allow UI-only lang/locale in case it reaches here (defense in depth)
      lang: z.string().optional(),
      locale: z.string().optional(),

      status: z.enum(["reserved", "confirmed", "released", "expired"]).optional(),
      productId: z.string().optional(),
      orderId: z.string().optional(),
      userId: z.string().optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
      sortBy: z.enum(["createdAt", "updatedAt", "status", "expiresAt"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    })
    .strict()
    .optional(),
});

const releaseSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

/* ============================
   GET /api/v1/admin/stock-reservations
============================ */

router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    if (q.productId && !isValidObjectId(q.productId)) {
      return sendError(res, 400, "INVALID_FILTER", "Invalid productId");
    }
    if (q.orderId && !isValidObjectId(q.orderId)) {
      return sendError(res, 400, "INVALID_FILTER", "Invalid orderId");
    }
    if (q.userId && !isValidObjectId(q.userId)) {
      return sendError(res, 400, "INVALID_FILTER", "Invalid userId");
    }

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.status) filter.status = q.status;
    if (q.productId) filter["items.productId"] = new mongoose.Types.ObjectId(q.productId);
    if (q.orderId) filter.orderId = new mongoose.Types.ObjectId(q.orderId);
    if (q.userId) filter.userId = new mongoose.Types.ObjectId(q.userId);

    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) filter.createdAt.$gte = new Date(q.dateFrom);
      if (q.dateTo) filter.createdAt.$lte = new Date(q.dateTo);
    }

    let sortOption = { createdAt: -1 };
    if (q.sortBy) {
      const dir = q.sortDir === "asc" ? 1 : -1;
      sortOption = { [q.sortBy]: dir };
    }

    const [items, total] = await Promise.all([
      StockReservation.find(filter).sort(sortOption).skip(skip).limit(limit).lean(),
      StockReservation.countDocuments(filter),
    ]);

    return sendOk(res, items, {
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
   POST /api/v1/admin/stock-reservations/:id/release
============================ */

router.post("/:id/release", validate(releaseSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id || "");
    if (!isValidObjectId(id)) {
      return sendError(res, 400, "INVALID_ID", "Invalid reservation id");
    }

    const existing = await StockReservation.findById(id);
    if (!existing) {
      return sendError(res, 404, "NOT_FOUND", "Reservation not found");
    }

    if (existing.status !== "reserved") {
      return sendOk(res, {
        reservation: existing,
        released: false,
      });
    }

    const released = await releaseStockReservation({ orderId: existing.orderId });
    const current = released || (await StockReservation.findById(id));

    return sendOk(res, {
      reservation: current,
      released: Boolean(released),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
