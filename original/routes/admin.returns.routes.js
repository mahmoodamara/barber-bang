// src/routes/admin.returns.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

import { ReturnRequest } from "../models/ReturnRequest.js";
import { Order } from "../models/Order.js";

import { refundStripeOrder } from "../services/refunds.service.js";
import { computeReturnRefundAmountMajor } from "../utils/returns.policy.js";

const router = express.Router();
router.use(requireAuth());
router.use(requireRole("admin"));

/* =========================
   Helpers
========================= */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function makeErr(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function jsonErr(res, e) {
  return res.status(e.statusCode || 500).json({
    ok: false,
    error: {
      code: e.code || "INTERNAL_ERROR",
      message: e.message || "Unexpected error",
    },
  });
}

function clampLimit(v, def = 200, max = 300) {
  const n = Number(v || def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

/**
 * Order.return.status enum عندك:
 * ["none","requested","approved","rejected","received","refunded"]
 *
 * ReturnRequest.status عندك:
 * ["requested","approved","rejected","received","refund_pending","refunded","closed"]
 *
 * لذلك "refund_pending / closed" ما بنحطها بـ Order.return.status
 */
function mapReturnRequestStatusToOrderReturnStatus(rrStatus) {
  const s = String(rrStatus || "");
  if (s === "requested") return "requested";
  if (s === "approved") return "approved";
  if (s === "rejected") return "rejected";
  if (s === "received") return "received";
  if (s === "refunded") return "refunded";
  return null; // refund_pending / closed
}

async function syncOrderReturn(orderId, rr, adminNote = "") {
  if (!orderId) return;

  const mapped = mapReturnRequestStatusToOrderReturnStatus(rr?.status);
  const patch = {};

  if (mapped) {
    patch["return.status"] = mapped;
    patch["return.processedAt"] = new Date();

    // لما يكون في عملية ارجاع جارية
    if (["requested", "approved", "received"].includes(mapped)) {
      patch.status = "return_requested";
    }
  }

  if (adminNote) {
    patch.internalNote = String(adminNote).slice(0, 800);
  }

  if (!Object.keys(patch).length) return;
  await Order.updateOne({ _id: orderId }, { $set: patch });
}

/* =========================
   Schemas
========================= */

const listSchema = z.object({
  query: z.object({
    status: z
      .enum(["requested", "approved", "rejected", "received", "refund_pending", "refunded", "closed"])
      .optional(),
    limit: z.string().optional(),
    orderId: z.string().optional(),
    userId: z.string().optional(),
  }),
});

const patchSchema = z.object({
  params: z.object({ id: z.string().min(1) }), // ReturnRequest ID
  body: z.object({
    action: z.enum(["approve", "reject", "mark_received", "close"]),
    adminNote: z.string().max(800).optional(),
  }),
});

const refundSchema = z.object({
  params: z.object({ id: z.string().min(1) }), // ReturnRequest ID
  body: z.object({
    // optional override
    amount: z.number().min(0).optional(), // ILS major
    includeShipping: z.boolean().optional(),

    // optional override items (for partial refund by selected products)
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1).max(999),
        })
      )
      .optional(),

    note: z.string().max(800).optional(),
    reason: z.enum(["return", "customer_cancel", "out_of_stock", "fraud", "duplicate", "other"]).optional(),
  }),
});

/* =========================
   Routes
========================= */

/**
 * GET /api/v1/admin/returns?status=&limit=&orderId=&userId=
 */
router.get("/", validate(listSchema), async (req, res) => {
  try {
    const { status, limit, orderId, userId } = req.validated.query || {};
    const lim = clampLimit(limit, 200, 300);

    const filter = {};
    if (status) filter.status = status;

    if (orderId) {
      if (!isValidObjectId(orderId)) throw makeErr(400, "INVALID_ID", "Invalid orderId");
      filter.orderId = orderId;
    }

    if (userId) {
      if (!isValidObjectId(userId)) throw makeErr(400, "INVALID_ID", "Invalid userId");
      filter.userId = userId;
    }

    const items = await ReturnRequest.find(filter).sort({ requestedAt: -1 }).limit(lim);
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * GET /api/v1/admin/returns/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(404, "NOT_FOUND", "Return request not found");

    const item = await ReturnRequest.findById(id);
    if (!item) throw makeErr(404, "NOT_FOUND", "Return request not found");

    return res.json({ ok: true, data: item });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * PATCH /api/v1/admin/returns/:id
 * approve / reject / mark_received / close
 */
router.patch("/:id", validate(patchSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid return request id");

    const { action, adminNote } = req.validated.body;

    const rr = await ReturnRequest.findById(id);
    if (!rr) throw makeErr(404, "NOT_FOUND", "Return request not found");

    const cur = String(rr.status || "requested");

    const note = typeof adminNote === "string" ? adminNote.trim().slice(0, 800) : "";
    const patch = {};

    if (note) patch.adminNote = note;

    if (action === "approve") {
      if (cur !== "requested") throw makeErr(400, "INVALID_STATE", "Return must be in requested state");
      patch.status = "approved";
      patch.decidedAt = new Date();
    }

    if (action === "reject") {
      if (cur !== "requested") throw makeErr(400, "INVALID_STATE", "Return must be in requested state");
      patch.status = "rejected";
      patch.decidedAt = new Date();
    }

    if (action === "mark_received") {
      if (!["approved", "requested"].includes(cur)) {
        throw makeErr(400, "INVALID_STATE", "Return must be approved/requested to mark received");
      }
      patch.status = "received";
      patch.receivedAt = new Date();
    }

    if (action === "close") {
      if (!["rejected", "refunded", "received", "approved"].includes(cur)) {
        throw makeErr(400, "INVALID_STATE", "Return must be approved/received/refunded/rejected to close");
      }
      patch.status = "closed";
    }

    const updated = await ReturnRequest.findByIdAndUpdate(id, { $set: patch }, { new: true });

    // ✅ Sync into Order.return (best effort)
    try {
      if (updated?.orderId) {
        await syncOrderReturn(
          updated.orderId,
          updated,
          note ? `Return(${action}): ${note}` : `Return(${action})`
        );
      }
    } catch (syncErr) {
      console.warn("[admin.returns] syncOrderReturn failed:", syncErr?.message || syncErr);
    }

    return res.json({ ok: true, data: updated });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/v1/admin/returns/:id/refund
 * Stripe refund linked to ReturnRequest
 *
 * ✅ uses:
 * - computeReturnRefundAmountMajor() from your returns.policy.js
 * - refundStripeOrder() from your refunds.service.js
 */
router.post("/:id/refund", validate(refundSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid return request id");

    const idemKey = pickIdempotencyKey(req);
    const { amount, includeShipping, items, note, reason } = req.validated.body;

    const rr = await ReturnRequest.findById(id);
    if (!rr) throw makeErr(404, "NOT_FOUND", "Return request not found");

    const order = await Order.findById(rr.orderId);
    if (!order) throw makeErr(404, "ORDER_NOT_FOUND", "Order not found");

    if (order.paymentMethod !== "stripe") {
      throw makeErr(400, "REFUND_NOT_SUPPORTED", "Refunds are only supported for Stripe orders");
    }

    const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
    if (!paymentIntentId) throw makeErr(400, "MISSING_PAYMENT_INTENT", "Order has no paymentIntentId");

    // already refunded
    if (rr?.refund?.status === "succeeded" || rr.status === "refunded") {
      return res.json({ ok: true, data: rr });
    }

    // ✅ Compute refund amount:
    // 1) if admin passed amount => use it directly
    // 2) else use policy function based on rr.items or override items
    let refundAmountMajor = undefined;

    if (typeof amount === "number") {
      refundAmountMajor = amount;
    } else {
      const returnItems = Array.isArray(items) && items.length ? items : rr.items || [];
      refundAmountMajor = computeReturnRefundAmountMajor({
        order,
        returnItems,
        includeShipping,
      });
    }

    const finalIdem =
      idemKey || `refund:return:${String(rr._id)}:${String(paymentIntentId)}`.slice(0, 200);

    // mark return refund pending
    await ReturnRequest.updateOne(
      { _id: rr._id },
      {
        $set: {
          status: "refund_pending",
          "refund.status": "pending",
          ...(note ? { adminNote: String(note).slice(0, 800) } : {}),
        },
      }
    );

    // ✅ perform refund via service (this updates Order.refund + status)
    let updatedOrder = null;
    try {
      updatedOrder = await refundStripeOrder({
        orderId: order._id,
        amountMajor: typeof refundAmountMajor === "number" ? refundAmountMajor : undefined,
        reason: reason || "return",
        note: note || "Refund due to return request",
        idempotencyKey: finalIdem,
      });
    } catch (rfErr) {
      await ReturnRequest.updateOne(
        { _id: rr._id },
        {
          $set: {
            status: "refund_pending",
            "refund.status": "failed",
            "refund.failureMessage": String(rfErr?.message || "Refund failed").slice(0, 400),
            ...(note ? { adminNote: String(note).slice(0, 800) } : {}),
          },
        }
      );

      return res.status(202).json({
        ok: true,
        data: await ReturnRequest.findById(rr._id),
        warning: "REFUND_PENDING_MANUAL_ACTION",
      });
    }

    // ✅ mark ReturnRequest refunded
    const updatedRR = await ReturnRequest.findByIdAndUpdate(
      rr._id,
      {
        $set: {
          status: "refunded",
          refundedAt: new Date(),
          "refund.status": "succeeded",
          "refund.amount": Number(refundAmountMajor || order?.pricing?.total || 0),
          "refund.currency": "ils",
          "refund.stripeRefundId": String(updatedOrder?.refund?.stripeRefundId || ""),
          ...(note ? { adminNote: String(note).slice(0, 800) } : {}),
        },
      },
      { new: true }
    );

    // best-effort: sync Order.return.refunded
    try {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            "return.status": "refunded",
            "return.processedAt": new Date(),
          },
        }
      );
    } catch {}

    return res.json({ ok: true, data: updatedRR });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
