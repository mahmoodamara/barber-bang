// src/routes/orders.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { Order } from "../models/Order.js";

import { createStripeRefund } from "../services/stripe.service.js";
import { toMinorUnits, fromMinorUnits } from "../utils/stripe.js";
import { releaseStockReservation } from "../services/products.service.js";
import { releaseCouponReservation } from "../services/pricing.service.js";
import { calcCancellationFee } from "../utils/returns.policy.js";
import { mapOrder } from "../utils/mapOrder.js";
import { getRequestId } from "../middleware/error.js";

const router = express.Router();

/* -------------------------------- Helpers -------------------------------- */

function normalizePhone(raw) {
  let v = String(raw || "").trim();
  if (!v) return "";

  // keep digits + leading +
  v = v.replace(/[^\d+]/g, "");

  // normalize Israeli patterns:
  // +9725XXXXXXXX => 05XXXXXXXX
  // 9725XXXXXXXX  => 05XXXXXXXX
  // 5XXXXXXXX     => 05XXXXXXXX
  if (v.startsWith("+972")) v = v.replace("+972", "0");
  if (v.startsWith("972")) v = v.replace("972", "0");
  if (/^5\d{8,9}$/.test(v)) v = "0" + v;

  return v;
}

function shippingLabel(mode, lang = "he") {
  const he = {
    DELIVERY: "משלוח עד הבית",
    PICKUP_POINT: "נקודת איסוף",
    STORE_PICKUP: "איסוף מהחנות",
  };

  const ar = {
    DELIVERY: "توصيل للبيت",
    PICKUP_POINT: "نقطة استلام",
    STORE_PICKUP: "استلام من المتجر",
  };

  const L = String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";
  const dict = L === "ar" ? ar : he;
  return dict[mode] || (L === "ar" ? "شحن" : "משלוח");
}

function pickItemTitle(it, lang = "he") {
  const L = String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";

  const heTitle = it?.titleHe || it?.title || "";
  const arTitle = it?.titleAr || "";

  if (L === "ar") return arTitle || heTitle || it?.title || "";
  return heTitle || arTitle || it?.title || "";
}

function pickItemUnitPrice(it) {
  // Compatible with old shapes
  const v = it?.unitPrice ?? it?.price ?? it?.linePrice ?? 0;
  return Number(v || 0);
}

function safe404(res) {
  const req = res.req;
  return res.status(404).json({
    ok: false,
    error: {
      code: "ORDER_NOT_FOUND",
      message: "Order not found",
      requestId: getRequestId(req),
      path: req?.originalUrl || req?.url || "",
    },
  });
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

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function pickIdempotencyKey(req) {
  // optional header; if you already use it in client, great.
  // safe length limit for storage/indexing
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

async function releaseReservationBestEffort(orderId) {
  await releaseStockReservation({ orderId }).catch((e) => {
    console.warn("[best-effort] orders release stock reservation failed:", String(e?.message || e));
  });
}

async function releaseCouponBestEffort(order) {
  const code = String(order?.pricing?.discounts?.coupon?.code || order?.pricing?.couponCode || "").trim();
  if (!code) return;
  await releaseCouponReservation({ code, orderId: order._id }).catch((e) => {
    console.warn("[best-effort] orders release coupon reservation failed:", String(e?.message || e));
  });
}

function canCancelStatus(status) {
  // minimal safe cancel rules
  // you may expand later based on business policy
  return [
    "pending_payment",
    "paid",
    "payment_received",
    "stock_confirmed",
    "cod_pending_approval",
    "confirmed",
    "pending_cod",
  ].includes(String(status || ""));
}

/* ----------------------------- Schemas ----------------------------- */

const trackSchema = z.object({
  body: z.object({
    orderId: z.string().min(1),
    phone: z.string().min(7).max(30),
  }),
});

const cancelSchema = z.object({
  body: z.object({
    reason: z.string().max(300).optional(),
  }),
});

const returnRequestSchema = z.object({
  body: z.object({
    reason: z.string().min(2).max(600),
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1).max(999),
        })
      )
      .min(1)
      .max(200)
      .optional(),
  }),
});

/* ----------------------------- Routes ----------------------------- */

/**
 * GET /api/v1/orders/me
 * Authenticated user orders
 */
router.get("/me", requireAuth(), async (req, res) => {
  try {
    const items = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
    return res.json({ ok: true, data: items.map((it) => mapOrder(it, { lang: req.lang })) });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/v1/orders/track?lang=he|ar
 * Guest safe tracking (NO leakage)
 *
 * IMPORTANT: must be BEFORE "/:id"
 */
router.post("/track", validate(trackSchema), async (req, res) => {
  try {
    const { orderId, phone } = req.validated.body;

    if (!isValidObjectId(orderId)) return safe404(res);

    // lean() for speed (virtuals won't exist)
    const order = await Order.findById(orderId).lean();
    if (!order) return safe404(res);

    // Prefer shipping.phone (new schema), fallback to address.phone (old)
    const storedRaw = order?.shipping?.phone || order?.shipping?.address?.phone || "";

    const stored = normalizePhone(storedRaw);
    const provided = normalizePhone(phone);

    if (!stored || !provided || stored !== provided) return safe404(res);

    const safeItems = (order.items || []).map((it) => ({
      title: pickItemTitle(it, req.lang),
      qty: Number(it?.qty || 1),
      price: pickItemUnitPrice(it),
    }));

    const mode = order?.shipping?.mode || "DELIVERY";

    const safe = {
      id: order._id,
      orderNumber: order.orderNumber || "",
      status: order.status,
      createdAt: order.createdAt,

      // ✅ use pricing.total because lean() won't include virtuals
      total: Number(order?.pricing?.total ?? order?.total ?? 0),

      items: safeItems,
      shipping: {
        mode,
        label: shippingLabel(mode, req.lang),
      },
    };

    return res.json({ ok: true, data: safe });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * GET /api/v1/orders/:id/receipt
 * Authenticated - returns receipt/invoice URL when available
 *
 * Must be BEFORE "/:id"
 */
router.get("/:id/receipt", requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return safe404(res);

    const order = await Order.findOne({ _id: id, userId: req.user._id });
    if (!order) return safe404(res);

    const receiptUrl = String(order?.stripe?.receiptUrl || "");
    const invoiceUrl = String(order?.invoice?.url || "");

    // prefer receipt for Stripe payments
    const url = receiptUrl || invoiceUrl || "";

    if (!url) {
      return res.status(404).json({
        ok: false,
        error: {
          code: "RECEIPT_NOT_AVAILABLE",
          message: "Receipt not available yet",
          requestId: getRequestId(req),
          path: req.originalUrl || req.url || "",
        },
      });
    }

    return res.json({
      ok: true,
      data: {
        provider: order?.invoice?.provider || (receiptUrl ? "stripe" : "none"),
        url,
        status: order?.invoice?.status || (receiptUrl ? "issued" : "pending"),
        number: order?.invoice?.number || "",
        issuedAt: order?.invoice?.issuedAt || null,
        error: order?.invoice?.error || "",
      },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/v1/orders/:id/cancel
 * Authenticated cancel request
 * - COD: cancel only
 * - Stripe paid/confirmed: refund (full) + cancel status
 *
 * Must be BEFORE "/:id"
 */
router.post("/:id/cancel", requireAuth(), validate(cancelSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return safe404(res);

    const idemKey = pickIdempotencyKey(req);
    const isAdmin = req.user?.role === "admin";

    // fetch the order (owned by user)
    const order = await Order.findOne(isAdmin ? { _id: id } : { _id: id, userId: req.user._id });
    if (!order) return safe404(res);

    if (!canCancelStatus(order.status)) {
      throw makeErr(400, "CANCEL_NOT_ALLOWED", "Order cannot be cancelled at this stage");
    }

    // Idempotency: if already cancelled -> return current order
    if (order.status === "cancelled") {
      return res.json({ ok: true, data: mapOrder(order, { lang: req.lang }) });
    }

    const reason = String(req.validated.body?.reason || "");
    const totalMajor = Number(order?.pricing?.total ?? order?.total ?? 0);
    const totalMinor = toMinorUnits(totalMajor);
    const feeMinor = calcCancellationFee(totalMinor);
    const feeMajor = fromMinorUnits(feeMinor);

    const refundMinor = Math.max(0, totalMinor - feeMinor);
    const refundMajor = fromMinorUnits(refundMinor);

    const cancelledBy = isAdmin ? "admin" : "user";

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          status: "cancelled",
          "cancellation.cancelledAt": new Date(),
          "cancellation.cancelledBy": cancelledBy,
          "cancellation.reason": reason,
          "cancellation.feeAmount": feeMajor,
          ...(idemKey ? { "idempotency.cancelKey": idemKey } : {}),
        },
      }
    );
    await releaseReservationBestEffort(order._id);
    if (order?.couponReservation?.status === "reserved") {
      await releaseCouponBestEffort(order);
      await Order.updateOne(
        { _id: order._id },
        { $set: { "couponReservation.status": "released" } }
      );
    }

    const status = String(order.status || "");
    const stripePaidStatuses = new Set(["paid", "payment_received", "stock_confirmed", "confirmed"]);
    const shouldRefund = order.paymentMethod === "stripe" && stripePaidStatuses.has(status);
    const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
    if (!shouldRefund || order?.refund?.status === "succeeded" || !paymentIntentId || refundMajor <= 0) {
      const updated = await Order.findById(order._id);
      return res.json({ ok: true, data: mapOrder(updated, { lang: req.lang }) });
    }

    // set refund pending
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "refund.status": "pending",
          "refund.reason": "customer_cancel",
          "refund.requestedAt": new Date(),
          ...(idemKey ? { "idempotency.refundKey": idemKey } : {}),
        },
      }
    );

    // create refund (total - fee)
    try {
      const refund = await createStripeRefund({
        paymentIntentId,
        amountMajor: refundMajor,
        reason: "customer_cancel",
        idempotencyKey: idemKey || `refund:cancel:${String(order._id)}:${paymentIntentId}`,
      });

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            "refund.status": "succeeded",
            "refund.amount": refundMajor,
            "refund.currency": "ils",
            "refund.stripeRefundId": String(refund?.id || ""),
            "refund.refundedAt": new Date(),
            internalNote: "Cancelled and refunded (Stripe)",
          },
        }
      );

      const updated = await Order.findById(order._id);
      return res.json({ ok: true, data: mapOrder(updated, { lang: req.lang }) });
    } catch (rfErr) {
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            "refund.status": "failed",
            "refund.reason": "customer_cancel",
            "refund.failureMessage": String(rfErr?.message || "Refund failed"),
            internalNote: "Cancel accepted; refund failed - manual refund required",
          },
        }
      );

      const updated = await Order.findById(order._id);
      return res.status(202).json({
        ok: true,
        data: {
          ...mapOrder(updated, { lang: req.lang }),
          warning: "CANCEL_ACCEPTED_REFUND_PENDING",
        },
      });
    }
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/v1/orders/:id/return-request
 * Authenticated return request creation (simple workflow)
 *
 * Must be BEFORE "/:id"
 */
router.post("/:id/return-request", requireAuth(), validate(returnRequestSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return safe404(res);

    const order = await Order.findOne({ _id: id, userId: req.user._id });
    if (!order) return safe404(res);

    // You may choose stricter rules:
    // - only delivered
    // - within X days
    // For MVP Israel readiness: accept request and let admin decide.
    if (order?.return?.status && order.return.status !== "none") {
      return res.json({ ok: true, data: mapOrder(order, { lang: req.lang }) });
    }

    const reason = String(req.validated.body?.reason || "").trim();
    const items = Array.isArray(req.validated.body?.items) ? req.validated.body.items : [];

    // Basic sanity: if items provided, validate they exist in order
    if (items.length > 0) {
      const orderProductIds = new Set((order.items || []).map((it) => String(it.productId)));
      for (const x of items) {
        if (!isValidObjectId(x.productId) || !orderProductIds.has(String(x.productId))) {
          throw makeErr(400, "INVALID_RETURN_ITEM", "Return items must exist in the order");
        }
      }
    }

    const updated = await Order.findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          status: order.status === "delivered" ? "return_requested" : order.status,
          "return.status": "requested",
          "return.requestedAt": new Date(),
          "return.reason": reason,
          "return.items": items.map((x) => ({
            productId: new mongoose.Types.ObjectId(String(x.productId)),
            qty: Number(x.qty),
          })),
          internalNote: "Return requested by user",
        },
      },
      { new: true }
    );

    return res.json({ ok: true, data: mapOrder(updated, { lang: req.lang }) });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * GET /api/v1/orders/:id
 * Authenticated user order by id
 */
router.get("/:id", requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) return safe404(res);

    const item = await Order.findOne({ _id: id, userId: req.user._id });
    if (!item) return safe404(res);

    return res.json({ ok: true, data: mapOrder(item, { lang: req.lang }) });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
