// src/routes/stripe.webhook.routes.js
import express from "express";
import mongoose from "mongoose";

import {
  constructWebhookEvent,
  retrievePaymentIntent,
  extractChargeAndReceiptFromPI,
  createStripeRefund,
} from "../services/stripe.service.js";
import { consumeReservedCoupon, releaseCouponReservation } from "../services/pricing.service.js";
import {
  confirmStockReservation,
  releaseStockReservation,
  releaseExpiredReservations,
} from "../services/products.service.js";
import { createInvoiceForOrder, resolveInvoiceProvider } from "../services/invoice.service.js";

import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { getRequestId } from "../middleware/error.js";
import { recordOrderSale } from "../services/ranking.service.js";

const router = express.Router();

/* ============================
   Helpers
============================ */

function safe200(res) {
  // Stripe only needs 2xx
  return res.status(200).json({ ok: true, data: { received: true } });
}

function errorPayload(req, code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

function normalizeCoupon(code) {
  const v = String(code || "").trim();
  return v ? v.toUpperCase() : "";
}

function isAutoRefundEnabled() {
  const v = String(process.env.AUTO_REFUND_OUT_OF_STOCK || "true").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * ✅ Verify Stripe payment amount/currency matches order
 * CRITICAL: Prevents payment manipulation attacks
 */
function verifyPaymentAmount(session, order) {
  // Get expected amount from order (in minor units - agorot)
  const expectedAmountMinor = Math.round(Number(order?.pricing?.totalMinor || 0));
  const expectedCurrency = String(order?.currency || "ils").toLowerCase();

  // Get actual amount from Stripe session
  const actualAmountMinor = Math.round(Number(session?.amount_total || 0));
  const actualCurrency = String(session?.currency || "").toLowerCase();

  // Validate currency matches
  if (actualCurrency !== expectedCurrency) {
    return {
      valid: false,
      reason: "CURRENCY_MISMATCH",
      message: `Currency mismatch: expected ${expectedCurrency}, got ${actualCurrency}`,
      expected: { amount: expectedAmountMinor, currency: expectedCurrency },
      actual: { amount: actualAmountMinor, currency: actualCurrency },
    };
  }

  // Validate amount matches (allow 0 tolerance for exact match)
  if (actualAmountMinor !== expectedAmountMinor) {
    return {
      valid: false,
      reason: "AMOUNT_MISMATCH",
      message: `Amount mismatch: expected ${expectedAmountMinor} agorot, got ${actualAmountMinor} agorot`,
      expected: { amount: expectedAmountMinor, currency: expectedCurrency },
      actual: { amount: actualAmountMinor, currency: actualCurrency },
    };
  }

  return {
    valid: true,
    expected: { amount: expectedAmountMinor, currency: expectedCurrency },
    actual: { amount: actualAmountMinor, currency: actualCurrency },
  };
}

function buildRefundIdempotencyKey(orderId, paymentIntentId) {
  return `refund:oos:${String(orderId)}:${String(paymentIntentId || "")}`.slice(0, 200);
}

async function markReservationInvalidAndRefund(order, paymentIntentId, reason = "out_of_stock", note = "No valid stock reservation at payment confirmation") {
  const refundKey = buildRefundIdempotencyKey(order?._id, paymentIntentId || "missing");

  const couponCode = normalizeCoupon(
    order?.pricing?.discounts?.coupon?.code || order?.pricing?.couponCode,
  );
  if (couponCode) {
    await releaseCouponReservation({ code: couponCode, orderId: order?._id }).catch((e) => {
      console.warn("[best-effort] stripe webhook release coupon reservation failed:", String(e?.message || e));
    });
    await Order.updateOne(
      { _id: order?._id },
      { $set: { "couponReservation.status": "released" } }
    );
  }

  await Order.updateOne(
    { _id: order?._id, status: "pending_payment" },
    {
      $set: {
        status: "refund_pending",
        "refund.status": "pending",
        "refund.reason": reason,
        "refund.requestedAt": new Date(),
        "idempotency.refundKey": refundKey,
        internalNote: note,
      },
    },
  );

  if (!paymentIntentId) return;
  if (!isAutoRefundEnabled()) return;

  try {
    const refund = await createStripeRefund({
      paymentIntentId,
      reason: reason,
      idempotencyKey: refundKey,
    });

    await Order.updateOne(
      { _id: order?._id },
      {
        $set: {
          status: "refunded",
          "refund.status": "succeeded",
          "refund.amount": Number(order?.pricing?.total ?? 0),
          "refund.currency": "ils",
          "refund.reason": reason,
          "refund.stripeRefundId": String(refund?.id || ""),
          "refund.refundedAt": new Date(),
          internalNote: `Auto-refunded: ${note}`,
        },
      },
    );
  } catch (rfErr) {
    await Order.updateOne(
      { _id: order?._id },
      {
        $set: {
          status: "refund_pending",
          "refund.status": "failed",
          "refund.reason": reason,
          "refund.failureMessage": String(rfErr?.message || "Refund failed"),
          internalNote: `Auto-refund failed: ${note}`,
        },
      },
    );
  }
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
          "invoice.docType": invoice.docType || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": invoice.status || "pending",
          "invoice.error": invoice.error || "",
          "invoice.allocation": invoice.allocation || {},
        },
      },
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
      },
    );
  }
}

/**
 * Clear only purchased items from user cart (safer than cart = [])
 * Prevent deleting items user added AFTER starting checkout.
 * ✅ FIX: Now considers variantId to correctly handle variant products
 */
async function clearPurchasedItemsFromCart(userId, orderItems) {
  if (!orderItems?.length) return;

  // Build list of { productId, variantId } pairs from order
  const purchasedItems = (orderItems || [])
    .filter((x) => x?.productId)
    .map((x) => ({
      productId: String(x.productId),
      variantId: String(x.variantId || ""),
    }));

  if (!purchasedItems.length) return;

  // Get user's current cart
  const user = await User.findById(userId).select("cart");
  if (!user || !user.cart?.length) return;

  // Filter out purchased items (match both productId AND variantId)
  const newCart = user.cart.filter((cartItem) => {
    const cartProductId = String(cartItem.productId);
    const cartVariantId = String(cartItem.variantId || "");

    // Keep item if it's NOT in the purchased list
    return !purchasedItems.some(
      (p) => p.productId === cartProductId && p.variantId === cartVariantId
    );
  });

  // Only update if cart changed
  if (newCart.length !== user.cart.length) {
    await User.updateOne({ _id: userId }, { $set: { cart: newCart } });
  }
}

/* ============================
   Webhook Route
============================ */

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
      return res
        .status(400)
        .json(errorPayload(req, "INVALID_STRIPE_SIGNATURE", "Missing stripe-signature header"));
    }

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

    await releaseExpiredReservations().catch((e) => {
      console.warn("[best-effort] stripe webhook release expired reservations failed:", String(e?.message || e));
    });

    /**
     * Webhook idempotency gate:
     * Only process when the order is still pending_payment.
     */
    if (order.status !== "pending_payment") return safe200(res);

    // async failed => cancel (no stock changes)
    if (type === "checkout.session.async_payment_failed") {
      await releaseStockReservation({ orderId: order._id }).catch((e) => {
        console.warn("[best-effort] stripe webhook release stock reservation failed:", String(e?.message || e));
      });
      const couponCode = normalizeCoupon(
        order?.pricing?.discounts?.coupon?.code || order?.pricing?.couponCode,
      );
      if (couponCode) {
        await releaseCouponReservation({ code: couponCode, orderId: order._id }).catch((e) => {
          console.warn("[best-effort] stripe webhook release coupon reservation failed:", String(e?.message || e));
        });
        await Order.updateOne(
          { _id: order._id },
          { $set: { "couponReservation.status": "released" } }
        );
      }
      await Order.updateOne(
        { _id: order._id, status: "pending_payment" },
        {
          $set: {
            status: "cancelled",
            internalNote: "Stripe async payment failed",
          },
        },
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
     * ✅ CRITICAL: Verify paid amount/currency matches order.pricing.totalMinor
     * Prevents payment manipulation attacks where attacker pays less than expected
     */
    const amountVerification = verifyPaymentAmount(session, order);
    if (!amountVerification.valid) {
      console.error("[stripe.webhook] AMOUNT VERIFICATION FAILED:", amountVerification);
      await markReservationInvalidAndRefund(
        order,
        paymentIntentId,
        "fraud",
        `Payment amount verification failed: ${amountVerification.message}`
      );
      return safe200(res);
    }

    const now = new Date();
    const reservation = await confirmStockReservation({ orderId: order._id, now });
    if (!reservation) {
      await markReservationInvalidAndRefund(order, paymentIntentId, "out_of_stock", "No valid stock reservation at payment confirmation");
      return safe200(res);
    }

    /**
     * Lock order first (idempotent transition)
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
      { new: true },
    );

    if (!locked) return safe200(res);

    /**
     * Store receipt URL + chargeId (best-effort)
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
          },
        );
      } catch (e) {
        console.warn("[stripe.webhook] receipt extraction failed", e?.message || e);
      }
    }

    /**
     * Reservation already confirmed above (required for paid orders)
     */

    /**
     * ✅ Consume reserved coupon atomically
     * (If we refunded, we should not count coupon usage)
     */
    const couponCode = normalizeCoupon(
      locked?.pricing?.discounts?.coupon?.code || locked?.pricing?.couponCode,
    );

    if (couponCode) {
      const couponResult = await consumeReservedCoupon({
        code: couponCode,
        orderId: locked._id,
      });
      if (!couponResult.success && !couponResult.alreadyUsed) {
        console.warn("[stripe.webhook] Coupon consume failed:", couponResult.error);
        await markReservationInvalidAndRefund(
          locked,
          paymentIntentId,
          "other",
          `Coupon reservation invalid: ${couponResult.error || "unknown"}`
        );
        return safe200(res);
      }

      await Order.updateOne(
        { _id: locked._id },
        {
          $set: {
            "couponReservation.status": "consumed",
            "couponReservation.expiresAt": null,
          },
        }
      );
    }

    /**
     * Clear purchased items from cart AFTER success
     */
    await clearPurchasedItemsFromCart(locked.userId, locked.items);

    /**
     * Move order to confirmed after stock is successfully decremented
     * paid = payment captured
     * confirmed = stock allocated + order ready for fulfillment
     */
    await Order.updateOne({ _id: locked._id, status: "paid" }, { $set: { status: "confirmed" } });

    // ✅ Record sales counters (idempotent)
    await recordOrderSale(locked, { now }).catch(() => {});

    await issueInvoiceBestEffort(locked._id);

    return safe200(res);
  } catch (err) {
    console.error("[stripe.webhook] error", err);
    // Stripe will retry on non-2xx; we return 400 only for signature/event parsing issues
    return res
      .status(400)
      .json(errorPayload(req, "INVALID_STRIPE_SIGNATURE", `Webhook Error: ${err?.message || "Unknown error"}`));
  }
});

export default router;
