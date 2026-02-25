// src/routes/admin.returns.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import {
  requireAuth,
  requirePermission,
  requireAnyPermission,
  PERMISSIONS,
} from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";

import { ReturnRequest } from "../models/ReturnRequest.js";
import { Order } from "../models/Order.js";

import { refundStripeOrder } from "../services/refunds.service.js";
import { computeReturnRefundAmountMajor } from "../utils/returns.policy.js";
import { sendOk, sendError } from "../utils/response.js";
import { sendRefundNotificationSafe } from "../services/email.service.js";
import { restockReturnedItems } from "../services/products.service.js";

const router = express.Router();

/**
 * Router gate:
 * - Must be authenticated
 * - Must have at least one of ORDERS_WRITE or REFUNDS_WRITE to access any returns route
 * - Per-endpoint checks remain (list/details/patch need ORDERS_WRITE; refund needs REFUNDS_WRITE)
 * - Audit all actions
 */
router.use(requireAuth());
router.use(
  requireAnyPermission(PERMISSIONS.ORDERS_WRITE, PERMISSIONS.REFUNDS_WRITE),
);
router.use(auditAdmin());

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

function jsonErr(req, res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error",
    {
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  );
}

function safeNotFound(req, res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message, {
    requestId: getRequestId(req),
    path: req.originalUrl || req.url || "",
  });
}

function clampLimit(v, def = 50, max = 200) {
  const n = Number(v ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeSearchRegex(input, maxLen = 120) {
  const safe = String(input || "")
    .trim()
    .slice(0, maxLen);
  if (!safe) return null;
  return new RegExp(escapeRegex(safe), "i");
}

/**
 * Generate deterministic idempotency key from return request + payment intent.
 * Prevents duplicate refunds even if endpoint is called multiple times.
 */
function buildDeterministicIdempotencyKey(returnRequestId, paymentIntentId) {
  const rrId = String(returnRequestId || "");
  const piId = String(paymentIntentId || "");
  if (!rrId || !piId) return "";
  return `refund:return:${rrId}:${piId}`.slice(0, 200);
}

/**
 * Order.return.status enum (legacy embedded):
 * ["none","requested","approved","rejected","received","refunded"]
 *
 * ReturnRequest.status enum:
 * ["requested","approved","rejected","received","refund_pending","refunded","closed"]
 *
 * Therefore: refund_pending/closed do NOT map into Order.return.status.
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

/**
 * Best-effort sync ReturnRequest status into Order.return + potentially Order.status.
 * Does not throw (caller can catch).
 */
async function syncOrderReturn(orderId, rr, adminNote = "") {
  if (!orderId || !isValidObjectId(orderId)) return;

  const mapped = mapReturnRequestStatusToOrderReturnStatus(rr?.status);
  const patch = {};

  if (mapped) {
    patch["return.status"] = mapped;
    patch["return.processedAt"] = new Date();

    // If a return flow is active, set an order-level status marker
    if (["requested", "approved", "received"].includes(mapped)) {
      patch.status = "return_requested";
    }
  }

  if (adminNote) {
    patch.internalNote = String(adminNote).trim().slice(0, 800);
  }

  if (!Object.keys(patch).length) return;
  await Order.updateOne({ _id: orderId }, { $set: patch });
}

/**
 * Guarded number selection (allows 0).
 */
function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/* =========================
   Schemas
========================= */

const listSchema = z.object({
  query: z
    .object({
      status: z
        .enum([
          "requested",
          "approved",
          "rejected",
          "received",
          "refund_pending",
          "refunded",
          "closed",
        ])
        .optional(),
      limit: z.string().regex(/^\d+$/).optional(),
      offset: z.string().regex(/^\d+$/).optional(),

      orderId: z.string().optional(),
      userId: z.string().optional(),

      // Optional quick search (by orderId-like / phone / email snapshot if exists in rr)
      q: z.string().max(120).optional(),
    })
    .strict()
    .optional(),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
});

const patchSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(), // ReturnRequest ID
  body: z
    .object({
      action: z.enum(["approve", "reject", "mark_received", "close"]),
      adminNote: z.string().max(800).optional(),
    })
    .strict(),
});

const refundSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(), // ReturnRequest ID
  body: z
    .object({
      // optional override
      amount: z.number().min(0).optional(), // ILS major
      includeShipping: z.boolean().optional(),

      // optional override items (partial refund by selected products)
      items: z
        .array(
          z
            .object({
              productId: z.string().min(1),
              qty: z.number().int().min(1).max(999),
            })
            .strict(),
        )
        .max(200)
        .optional(),

      note: z.string().max(800).optional(),
      reason: z
        .enum([
          "return",
          "customer_cancel",
          "out_of_stock",
          "fraud",
          "duplicate",
          "other",
        ])
        .optional(),
    })
    .strict(),
});

/* =========================
   Routes
========================= */

/**
 * GET /api/v1/admin/returns?status=&limit=&offset=&orderId=&userId=&q=
 * Requires ORDERS_WRITE (list view)
 */
router.get(
  "/",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(listSchema),
  async (req, res) => {
    try {
      const q = req.validated?.query || {};
      const lim = clampLimit(q.limit, 50, 200);
      const offset = Math.max(0, Math.floor(Number(q.offset ?? 0)) || 0);

      const filter = {};

      if (q.status) filter.status = q.status;

      if (q.orderId) {
        if (!isValidObjectId(q.orderId))
          throw makeErr(400, "INVALID_ID", "Invalid orderId");
        filter.orderId = q.orderId;
      }

      if (q.userId) {
        if (!isValidObjectId(q.userId))
          throw makeErr(400, "INVALID_ID", "Invalid userId");
        filter.userId = q.userId;
      }

      if (q.q) {
        const rx = makeSearchRegex(q.q);
        if (rx) {
          filter.$or = [
            { orderId: isValidObjectId(q.q) ? q.q : undefined },
            { phone: rx },
            { email: rx },
            { customerNote: rx },
            { adminNote: rx },
          ].filter(Boolean);
        }
      }

      const [items, total] = await Promise.all([
        ReturnRequest.find(filter)
          .sort({ requestedAt: -1 })
          .skip(offset)
          .limit(lim)
          .select(
            "_id userId orderId status reason requestedAt decidedAt receivedAt refundedAt refund adminNote phone email items",
          )
          .lean(),
        ReturnRequest.countDocuments(filter),
      ]);

      return sendOk(res, items, { limit: lim, offset, total });
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/**
 * GET /api/v1/admin/returns/:id
 * Requires ORDERS_WRITE (details view)
 */
router.get(
  "/:id",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(idParamSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id))
        return safeNotFound(req, res, "NOT_FOUND", "Return request not found");

      const item = await ReturnRequest.findById(id)
        .select(
          "_id userId orderId status reason requestedAt decidedAt receivedAt refundedAt refund adminNote phone email items customerNote",
        )
        .lean();

      if (!item)
        return safeNotFound(req, res, "NOT_FOUND", "Return request not found");
      return sendOk(res, item);
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/**
 * PATCH /api/v1/admin/returns/:id
 * approve / reject / mark_received / close
 * Requires ORDERS_WRITE
 */
router.patch(
  "/:id",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(patchSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id))
        throw makeErr(400, "INVALID_ID", "Invalid return request id");

      const { action, adminNote } = req.validated.body;

      const rr = await ReturnRequest.findById(id);
      if (!rr) throw makeErr(404, "NOT_FOUND", "Return request not found");

      const cur = String(rr.status || "requested");
      const note =
        typeof adminNote === "string" ? adminNote.trim().slice(0, 800) : "";

      if (note) rr.adminNote = note;

      // Explicit state machine (clear rules)
      if (action === "approve") {
        if (cur !== "requested")
          throw makeErr(
            400,
            "INVALID_STATE",
            "Return must be in requested state",
          );
        rr.status = "approved";
        rr.decidedAt = new Date();
      } else if (action === "reject") {
        if (cur !== "requested")
          throw makeErr(
            400,
            "INVALID_STATE",
            "Return must be in requested state",
          );
        rr.status = "rejected";
        rr.decidedAt = new Date();
      } else if (action === "mark_received") {
        if (!["approved", "requested"].includes(cur)) {
          throw makeErr(
            400,
            "INVALID_STATE",
            "Return must be approved/requested to mark received",
          );
        }
        rr.status = "received";
        rr.receivedAt = new Date();

        // Restore stock for returned items
        if (Array.isArray(rr.items) && rr.items.length) {
          try {
            await restockReturnedItems(rr.items);
          } catch (stockErr) {
            req.log?.warn?.(
              { err: String(stockErr?.message || stockErr) },
              "[admin.returns] restock on mark_received failed",
            );
          }
        }
      } else if (action === "close") {
        if (!["rejected", "refunded", "received", "approved"].includes(cur)) {
          throw makeErr(
            400,
            "INVALID_STATE",
            "Return must be approved/received/refunded/rejected to close",
          );
        }
        rr.status = "closed";
      }

      await rr.save();

      // Best-effort sync into Order.return + order status
      try {
        if (rr.orderId) {
          await syncOrderReturn(
            rr.orderId,
            rr,
            note ? `Return(${action}): ${note}` : `Return(${action})`,
          );
        }
      } catch (syncErr) {
        req.log?.warn?.(
          { err: String(syncErr?.message || syncErr) },
          "[admin.returns] syncOrderReturn failed",
        );
      }

      return sendOk(res, rr);
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/**
 * POST /api/v1/admin/returns/:id/refund
 * Stripe refund linked to ReturnRequest
 *
 * ✅ Requires REFUNDS_WRITE permission
 * Uses deterministic idempotency key derived from returnRequestId + paymentIntentId.
 */
router.post(
  "/:id/refund",
  requirePermission(PERMISSIONS.REFUNDS_WRITE),
  validate(refundSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id))
        throw makeErr(400, "INVALID_ID", "Invalid return request id");

      const { amount, includeShipping, items, note, reason } =
        req.validated.body;

      const rr = await ReturnRequest.findById(id);
      if (!rr) throw makeErr(404, "NOT_FOUND", "Return request not found");

      // Idempotent: return current state if already succeeded
      if (rr.status === "refunded" || rr?.refund?.status === "succeeded") {
        return sendOk(res, rr);
      }

      const orderId = rr.orderId;
      if (!orderId || !isValidObjectId(orderId))
        throw makeErr(
          400,
          "INVALID_ORDER_ID",
          "Return request has invalid orderId",
        );

      const order = await Order.findById(orderId);
      if (!order) throw makeErr(404, "ORDER_NOT_FOUND", "Order not found");

      // Strong duplicate protection: if the order is already fully refunded successfully, sync RR and return
      if (
        order.status === "refunded" &&
        order?.refund?.status === "succeeded"
      ) {
        rr.status = "refunded";
        rr.refundedAt = order.refund?.refundedAt || new Date();
        rr.set("refund.status", "succeeded");
        rr.set("refund.amount", order.refund?.amount || 0);
        rr.set("refund.currency", String(order.refund?.currency || "ILS"));
        rr.set("refund.stripeRefundId", order.refund?.stripeRefundId || "");
        await rr.save();

        // best-effort sync
        try {
          await syncOrderReturn(
            order._id,
            rr,
            "Return(refund): synced from order refund state",
          );
        } catch (e) {
          req.log?.warn?.(
            { err: String(e?.message || e) },
            "[best-effort] syncOrderReturn (order already refunded) failed",
          );
        }

        return sendOk(res, rr);
      }

      if (order.paymentMethod !== "stripe") {
        throw makeErr(
          400,
          "REFUND_NOT_SUPPORTED",
          "Refunds are only supported for Stripe orders",
        );
      }

      const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
      if (!paymentIntentId)
        throw makeErr(
          400,
          "MISSING_PAYMENT_INTENT",
          "Order has no paymentIntentId",
        );

      const idempotencyKey = buildDeterministicIdempotencyKey(
        rr._id,
        paymentIntentId,
      );
      if (!idempotencyKey)
        throw makeErr(
          400,
          "MISSING_IDEMPOTENCY_KEY",
          "Failed to build deterministic idempotency key",
        );

      // Compute refund amount (major)
      let refundAmountMajor;

      if (isNumber(amount)) {
        refundAmountMajor = amount;
      } else {
        const returnItems =
          Array.isArray(items) && items.length ? items : rr.items || [];
        refundAmountMajor = computeReturnRefundAmountMajor({
          order,
          returnItems,
          includeShipping: Boolean(includeShipping),
        });
      }

      if (!isNumber(refundAmountMajor)) {
        throw makeErr(
          400,
          "INVALID_REFUND_AMOUNT",
          "Computed refund amount is invalid",
        );
      }

      // Mark refund pending (pre-state for UI)
      rr.status = "refund_pending";
      rr.set("refund.status", "pending");
      if (note) rr.adminNote = String(note).trim().slice(0, 800);
      await rr.save();

      // Perform refund via service (updates Order.refund + status)
      let updatedOrder;
      try {
        updatedOrder = await refundStripeOrder({
          orderId: order._id,
          amountMajor: refundAmountMajor, // keep 0 valid
          reason: reason || "return",
          note: note || "Refund due to return request",
          idempotencyKey,
        });
      } catch (rfErr) {
        // Refund failed - keep RR in refund_pending but mark failure
        rr.status = "refund_pending";
        rr.set("refund.status", "failed");
        rr.set(
          "refund.failureMessage",
          String(rfErr?.message || "Refund failed").slice(0, 400),
        );
        await rr.save();

        const rrObj = rr.toObject ? rr.toObject() : rr;
        return res.status(202).json({
          ok: true,
          success: true,
          data: {
            ...rrObj,
            warning: "REFUND_PENDING_MANUAL_ACTION",
          },
        });
      }

      // Mark ReturnRequest refunded
      rr.status = "refunded";
      rr.refundedAt = new Date();
      rr.set("refund.status", "succeeded");
      rr.set("refund.amount", refundAmountMajor); // 0-safe
      rr.set("refund.currency", "ILS");
      rr.set(
        "refund.stripeRefundId",
        String(updatedOrder?.refund?.stripeRefundId || ""),
      );
      await rr.save();

      // Best-effort: sync embedded Order.return state
      try {
        await syncOrderReturn(order._id, rr, "Return(refund): succeeded");
      } catch (e) {
        req.log?.warn?.(
          { err: String(e?.message || e) },
          "[best-effort] admin returns sync order refund status failed",
        );
      }

      // Best-effort: notify customer of successful refund
      sendRefundNotificationSafe(order._id, refundAmountMajor).catch(() => {});

      return sendOk(res, rr);
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

export default router;
