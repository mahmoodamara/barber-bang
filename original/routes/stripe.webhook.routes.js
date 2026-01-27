// src/routes/stripe.webhook.routes.js
import express from "express";
import mongoose from "mongoose";

import {
  constructWebhookEvent,
  retrievePaymentIntent,
  extractChargeAndReceiptFromPI,
  createStripeRefund,
} from "../services/stripe.service.js";
import {
  confirmStockReservation,
  releaseStockReservation,
  releaseExpiredReservations,
  decrementStockAtomicOrThrow,
} from "../services/products.service.js";
import { createInvoiceForOrder, resolveInvoiceProvider } from "../services/invoice.service.js";

import { Order } from "../models/Order.js";
import { Coupon } from "../models/Coupon.js";
import { User } from "../models/User.js";

const router = express.Router();

/* ============================
   Helpers
============================ */

function safe200(res) {
  // Stripe only needs 2xx
  return res.status(200).json({ received: true });
}

function normalizeCoupon(code) {
  const v = String(code || "").trim();
  return v ? v.toUpperCase() : "";
}

function isAutoRefundEnabled() {
  const v = String(process.env.AUTO_REFUND_OUT_OF_STOCK || "true").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function buildRefundIdempotencyKey(orderId, paymentIntentId) {
  return `refund:oos:${String(orderId)}:${String(paymentIntentId || "")}`.slice(0, 200);
}

async function issueInvoiceBestEffort(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return;
  if (order?.invoice?.status === "issued") return;

  try {
    const invoice = await createInvoiceForOrder(order);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": invoice.provider,
          "invoice.docId": invoice.docId || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": invoice.status || "pending",
          "invoice.error": invoice.error || "",
        },
      }
    );
  } catch (e) {
    const provider = resolveInvoiceProvider(order);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": provider,
          "invoice.docId": String(order._id),
          "invoice.number": "",
          "invoice.url": "",
          "invoice.issuedAt": null,
          "invoice.status": "failed",
          "invoice.error": String(e?.message || "Invoice failed"),
        },
      }
    );
  }
}

/**
 * ✅ Clear only purchased items from user cart (safer than cart = [])
 * Prevent deleting items user added AFTER starting checkout.
 */
async function clearPurchasedItemsFromCart(userId, orderItems) {
  const ids = (orderItems || [])
    .map((x) => x?.productId)
    .filter(Boolean)
    .map((x) => String(x));

  if (!ids.length) return;

  const objIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const rawIds = ids.filter((id) => !mongoose.Types.ObjectId.isValid(id));
  const inList = [...objIds, ...rawIds];
  if (!inList.length) return;

  await User.updateOne(
    { _id: userId },
    { $pull: { cart: { productId: { $in: inList } } } }
  );
}

/* ============================
   Webhook Route
============================ */

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature header");

    const event = constructWebhookEvent(req.body, sig);

    const type = String(event?.type || "");
    const accepted = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ]);

    if (!accepted.has(type)) return safe200(res);

    const session = event?.data?.object || {};
    const sessionId = String(session?.id || "");
    if (!sessionId) return safe200(res);

    // Find order by Stripe sessionId
    const order = await Order.findOne({
      paymentMethod: "stripe",
      "stripe.sessionId": sessionId,
    });

    // Always 200 (do not leak)
    if (!order) return safe200(res);

    await releaseExpiredReservations().catch(() => {});

    /**
     * ✅ Webhook idempotency gate:
     * Only process when the order is still pending_payment.
     */
    if (order.status !== "pending_payment") return safe200(res);

    // async failed => cancel (no stock changes)
    if (type === "checkout.session.async_payment_failed") {
      await releaseStockReservation({ orderId: order._id }).catch(() => {});
      await Order.updateOne(
        { _id: order._id, status: "pending_payment" },
        {
          $set: {
            status: "cancelled",
            internalNote: "Stripe async payment failed",
          },
        }
      );
      return safe200(res);
    }

    // For completed/async_succeeded, ensure it's actually paid
    const paymentStatus = String(session?.payment_status || "").toLowerCase();
    if (paymentStatus && paymentStatus !== "paid") {
      return safe200(res);
    }

    const paymentIntentId = session?.payment_intent ? String(session.payment_intent) : "";

    /**
     * ✅ Lock order first (idempotent transition)
     * pending_payment -> paid (exactly once)
     */
    const locked = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: "pending_payment",
        paymentMethod: "stripe",
        "stripe.sessionId": sessionId,
      },
      {
        $set: {
          status: "paid",
          "stripe.paymentIntentId": paymentIntentId,
        },
      },
      { new: true }
    );

    if (!locked) return safe200(res);

    /**
     * ✅ Store receipt URL + chargeId (best-effort)
     */
    if (paymentIntentId) {
      try {
        const pi = await retrievePaymentIntent(paymentIntentId);
        const { chargeId, receiptUrl } = extractChargeAndReceiptFromPI(pi);

        await Order.updateOne(
          { _id: locked._id },
          {
            $set: {
              "stripe.chargeId": chargeId || "",
              "stripe.receiptUrl": receiptUrl || "",
              "invoice.provider": receiptUrl ? "stripe" : locked?.invoice?.provider || "none",
            },
          }
        );
      } catch (e) {
        console.warn("[stripe.webhook] receipt extraction failed", e?.message || e);
      }
    }

    /**
     * ✅ Stock reservation confirmation (or fallback decrement)
     * If fails => refund flow (Israel operational correctness)
     */
    const confirmed = await confirmStockReservation({ orderId: locked._id });

    if (!confirmed) {
      try {
        await decrementStockAtomicOrThrow(locked.items);
      } catch (e) {
        const isOOS = String(e?.code || "") === "OUT_OF_STOCK";

        // Not out-of-stock error => mark refund pending (manual)
        if (!isOOS) {
          await Order.updateOne(
            { _id: locked._id },
            {
              $set: {
                status: "refund_pending",
                "refund.status": "pending",
                "refund.reason": "other",
                "refund.requestedAt": new Date(),
                internalNote: `Stock decrement failed after payment: ${String(e?.message || "unknown")}`,
              },
            }
          );
          return safe200(res);
        }

        // Out of stock after payment
        if (!paymentIntentId) {
          await Order.updateOne(
            { _id: locked._id },
            {
              $set: {
                status: "refund_pending",
                "refund.status": "pending",
                "refund.reason": "out_of_stock",
                "refund.requestedAt": new Date(),
                internalNote: "Out of stock after payment but paymentIntentId missing",
              },
            }
          );
          return safe200(res);
        }

        // Auto-refund disabled => manual refund required
        if (!isAutoRefundEnabled()) {
          await Order.updateOne(
            { _id: locked._id },
            {
              $set: {
                status: "refund_pending",
                "refund.status": "pending",
                "refund.reason": "out_of_stock",
                "refund.requestedAt": new Date(),
                internalNote: "Out of stock after payment. Auto-refund disabled; manual refund required.",
              },
            }
          );
          return safe200(res);
        }

        // mark refund pending first
        const refundKey = buildRefundIdempotencyKey(locked._id, paymentIntentId);

        await Order.updateOne(
          { _id: locked._id },
          {
            $set: {
              status: "refund_pending",
              "refund.status": "pending",
              "refund.reason": "out_of_stock",
              "refund.requestedAt": new Date(),
              "idempotency.refundKey": refundKey,
            },
          }
        );

        // ✅ Create refund (idempotent)
        try {
          const refund = await createStripeRefund({
            paymentIntentId,
            reason: "out_of_stock",
            idempotencyKey: refundKey,
          });

          await Order.updateOne(
            { _id: locked._id },
            {
              $set: {
                status: "refunded",
                "refund.status": "succeeded",
                "refund.amount": Number(locked?.pricing?.total ?? 0),
                "refund.currency": "ils",
                "refund.reason": "out_of_stock",
                "refund.stripeRefundId": String(refund?.id || ""),
                "refund.refundedAt": new Date(),
                internalNote: "Auto-refunded due to out-of-stock after payment",
              },
            }
          );
        } catch (rfErr) {
          await Order.updateOne(
            { _id: locked._id },
            {
              $set: {
                status: "refund_pending",
                "refund.status": "failed",
                "refund.reason": "out_of_stock",
                "refund.failureMessage": String(rfErr?.message || "Refund failed"),
                internalNote: "Auto-refund failed, manual refund required",
              },
            }
          );
        }

        return safe200(res);
      }
    }

    /**
     * ✅ Coupon usedCount increment AFTER stock decrement success
     * (If we refunded, we should not count coupon usage)
     */
    const couponCode = normalizeCoupon(
      locked?.pricing?.discounts?.coupon?.code || locked?.pricing?.couponCode
    );

    if (couponCode) {
      await Coupon.updateOne({ code: couponCode }, { $inc: { usedCount: 1 } });
    }

    /**
     * ✅ Clear purchased items from cart AFTER success
     */
    await clearPurchasedItemsFromCart(locked.userId, locked.items);

    /**
     * ✅ Move order to confirmed after stock is successfully decremented
     * paid = payment captured
     * confirmed = stock allocated + order ready for fulfillment
     */
    await Order.updateOne(
      { _id: locked._id, status: "paid" },
      { $set: { status: "confirmed" } }
    );

    await issueInvoiceBestEffort(locked._id);

    return safe200(res);
  } catch (err) {
    console.error("[stripe.webhook] error", err);
    // Stripe will retry on non-2xx — we return 400 only for signature/event parsing issues
    return res.status(400).send(`Webhook Error: ${err?.message || "Unknown error"}`);
  }
});

export default router;
