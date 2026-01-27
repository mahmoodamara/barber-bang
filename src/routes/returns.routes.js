// src/routes/returns.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";

import { evaluateReturnEligibility } from "../utils/returns.policy.js";
import { getRequestId } from "../middleware/error.js";

const router = express.Router();
router.use(requireAuth());

/* =========================
   Helpers
========================= */

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonErr(res, e) {
  const req = res.req;
  return res.status(e.statusCode || 500).json({
    ok: false,
    error: {
      code: e.code || "INTERNAL_ERROR",
      message: e.message || "Unexpected error",
      requestId: getRequestId(req),
      path: req?.originalUrl || req?.url || "",
    },
  });
}

function safeLang(lang) {
  const v = String(lang || "he").toLowerCase();
  return v === "ar" ? "ar" : "he";
}

function pickTitle(it, lang) {
  const L = safeLang(lang);
  if (L === "ar") return it?.titleAr || it?.titleHe || it?.title || "";
  return it?.titleHe || it?.titleAr || it?.title || "";
}

function clampQty(n) {
  const v = Number(n || 1);
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(999, Math.floor(v)));
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

/* =========================
   Schemas
========================= */

const createSchema = z.object({
  body: z.object({
    orderId: z.string().min(1),
    reason: z.enum(["wrong_item", "damaged", "not_as_described", "changed_mind", "other"]).optional(),
    note: z.string().max(800).optional(),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1).max(999),
        })
      )
      .optional(),
  }),
});

/* =========================
   Routes
========================= */

/**
 * POST /api/v1/returns
 * Create return request for an order (user-owned only)
 */
router.post("/", validate(createSchema), async (req, res) => {
  try {
    const { orderId, reason, note, items } = req.validated.body;

    if (!isValidObjectId(orderId)) {
      throw makeErr(400, "INVALID_ORDER_ID", "Invalid orderId");
    }

    const order = await Order.findOne({ _id: orderId, userId: req.user._id });
    if (!order) throw makeErr(404, "ORDER_NOT_FOUND", "Order not found");

    // ✅ Use official policy (single source of truth)
    const policy = evaluateReturnEligibility(order);
    if (!policy.eligible) {
      throw makeErr(400, policy.code || "RETURN_NOT_ALLOWED", policy.message || "Return not allowed");
    }

    // ✅ extra safety: if order already in return flow
    const embeddedStatus = String(order?.return?.status || "none");
    if (embeddedStatus && embeddedStatus !== "none" && embeddedStatus !== "requested") {
      throw makeErr(400, "RETURN_ALREADY_PROCESSED", `Return already processed: ${embeddedStatus}`);
    }

    // ensure no existing active request in ReturnRequest collection
    const existing = await ReturnRequest.findOne({
      orderId: order._id,
      status: { $in: ["requested", "approved", "received", "refund_pending"] },
    });
    if (existing) {
      return res.json({ ok: true, data: existing });
    }

    // Build return items
    const orderItems = Array.isArray(order.items) ? order.items : [];
    let selectedItems = [];

    if (Array.isArray(items) && items.length > 0) {
      // user-selected subset
      const map = new Map(orderItems.map((it) => [String(it.productId), it]));

      selectedItems = items
        .map((x) => {
          const base = map.get(String(x.productId));
          if (!base) return null;

          const qty = clampQty(x.qty);
          const maxQty = clampQty(base.qty);

          return {
            productId: base.productId,
            qty: Math.min(qty, maxQty),

            titleHe: base.titleHe || "",
            titleAr: base.titleAr || "",
            title: base.title || "",

            unitPrice: Number(base.unitPrice || 0),
          };
        })
        .filter(Boolean);
    } else {
      // default: all items
      selectedItems = orderItems.map((it) => ({
        productId: it.productId,
        qty: clampQty(it.qty),

        titleHe: it.titleHe || "",
        titleAr: it.titleAr || "",
        title: it.title || "",

        unitPrice: Number(it.unitPrice || 0),
      }));
    }

    if (!selectedItems.length) {
      throw makeErr(400, "EMPTY_RETURN_ITEMS", "No return items selected");
    }

    const rr = await ReturnRequest.create({
      orderId: order._id,
      userId: req.user._id,
      phone: String(order?.shipping?.phone || order?.shipping?.address?.phone || ""),
      email: String(req.user?.email || ""),
      reason: reason || "other",
      customerNote: String(note || ""),
      items: selectedItems,
      status: "requested",
      requestedAt: new Date(),
    });

    // ✅ reflect on Order too (embedded + main status)
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          status: "return_requested",
          "return.status": "requested",
          "return.requestedAt": new Date(),
        },
      }
    );

    return res.status(201).json({
      ok: true,
      data: {
        ...rr.toObject(),
        items: rr.items.map((it) => ({
          productId: it.productId,
          qty: it.qty,
          title: pickTitle(it, req.lang),
          unitPrice: it.unitPrice,
        })),
      },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * GET /api/v1/returns/me
 * List my return requests
 */
router.get("/me", async (req, res) => {
  try {
    const items = await ReturnRequest.find({ userId: req.user._id })
      .sort({ requestedAt: -1 })
      .limit(100);

    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * GET /api/v1/returns/:id
 * View my return request
 */
router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      throw makeErr(404, "NOT_FOUND", "Return request not found");
    }

    const item = await ReturnRequest.findOne({ _id: id, userId: req.user._id });
    if (!item) throw makeErr(404, "NOT_FOUND", "Return request not found");

    return res.json({ ok: true, data: item });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
