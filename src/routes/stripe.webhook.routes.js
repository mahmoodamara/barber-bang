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
import { issueInvoiceWithLock } from "../services/invoice.service.js";

import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { Payment } from "../models/Payment.js";
import { StripeWebhookEvent } from "../models/StripeWebhookEvent.js";
import { getRequestId } from "../middleware/error.js";
import { recordOrderSale } from "../services/ranking.service.js";
import { log } from "../utils/logger.js";
import { onWebhookFailure } from "../utils/alertHooks.js";
import { getWebhookEventCounter, getRefundOperationsCounter } from "../middleware/prometheus.js";

/**
 * Safe status set for metadata fallback lookup.
 * Only allow finding orders in these statuses to prevent double-processing.
 */
const SAFE_FALLBACK_STATUSES = new Set(["pending_payment", "paid"]);
const WEBHOOK_LOCK_STALE_MINUTES =
  Number(process.env.STRIPE_WEBHOOK_LOCK_STALE_MINUTES) || 10;

const router = express.Router();

/* ============================
   Helpers
============================ */

function safe200(res) {
  // Stripe only needs 2xx
  return res.status(200).json({ ok: true, data: { received: true } });
}

/**
 * Structured log for metadata fallback path (no PII)
 */
function logMetadataFallback({ requestId, sessionId, orderId, eventType, success, reason }) {
  const sessionSuffix = sessionId ? sessionId.slice(-6) : "N/A";
  const orderSuffix = orderId ? orderId.slice(-6) : "N/A";
  log.info(
    { requestId, sessionSuffix, orderSuffix, eventType, success, reason: reason || "none" },
    "[stripe.webhook] METADATA_FALLBACK"
  );
}

function logWebhookFailure({ req, eventId, orderId, step, error }) {
  const requestId = getRequestId(req);
  req.log.error(
    {
      requestId,
      stripeEventId: eventId,
      orderId,
      step,
      err: String(error?.message || error || ""),
    },
    "[stripe.webhook] FAILURE"
  );
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
      log.warn({ err: String(e?.message || e) }, "[best-effort] stripe webhook release coupon reservation failed");
    });
    await Order.updateOne(
      { _id: order?._id },
      { $set: { "couponReservation.status": "released" } }
    );
  }

  await Order.updateOne(
    { _id: order?._id, status: { $in: ["pending_payment", "paid"] } },
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

    const refundIdStr = String(refund?.id || "");
    await Order.updateOne(
      { _id: order?._id },
      {
        $set: {
          status: "refunded",
          "refund.status": "succeeded",
          "refund.amount": Number(order?.pricing?.total ?? 0),
          "refund.currency": "ils",
          "refund.reason": reason,
          "refund.stripeRefundId": refundIdStr,
          "refund.refundedAt": new Date(),
          internalNote: `Auto-refunded: ${note}`,
        },
      },
    );

    const amountMinor = Math.round(
      Number(order?.pricing?.totalMinor ?? (Number(order?.pricing?.total ?? 0) * 100))
    );
    try {
      await Payment.create({
        transactionId: refundIdStr || refundKey,
        type: "refund",
        orderId: order._id,
        userId: order.userId || null,
        amountMinor: Number.isFinite(amountMinor) && amountMinor >= 0 ? amountMinor : 0,
        currency: "ils",
        status: "succeeded",
        provider: "stripe",
        refundId: refundIdStr,
      });
    } catch (ledgerErr) {
      if (ledgerErr?.code !== 11000) {
        log.warn({ err: String(ledgerErr?.message || ledgerErr) }, "[stripe.webhook] refund ledger insert failed");
      }
    }
    getRefundOperationsCounter().inc({ type: "stripe", status: "success" });
  } catch (rfErr) {
    getRefundOperationsCounter().inc({ type: "stripe", status: "failure" });
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

function buildInvoiceIdempotencyKey(order) {
  const pi = String(order?.stripe?.paymentIntentId || "").trim();
  return `invoice:${order?._id}:${pi}`.slice(0, 200);
}

async function releaseWebhookLock(orderId, lockId) {
  if (!orderId || !lockId) return;
  await Order.updateOne(
    { _id: orderId, "webhook.lockId": lockId },
    { $set: { "webhook.lockId": "", "webhook.lockedAt": null } }
  ).catch(() => {});
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

const webhookEventsTotal = getWebhookEventCounter();

router.post(
  "/",
  express.raw({
    type: ["application/json", "application/json; charset=utf-8"],
    verify: (req, _res, buf) => {
      req.rawBodyString = buf.toString("utf-8");
    },
  }),
  async (req, res) => {
  let type = "unknown";
  let lockId = "";
  let lockedOrderId = null;
  let eventId = "";
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
      webhookEventsTotal.inc({ type: "unknown", status: "error" });
      onWebhookFailure({ requestId: getRequestId(req), type: "unknown", status: "error", reason: "missing_signature" });
      return res
        .status(400)
        .json(errorPayload(req, "INVALID_STRIPE_SIGNATURE", "Missing stripe-signature header"));
    }

    // Use raw body captured in verify callback, or fallback to req.body (Buffer/object/string)
    let rawBody = req.rawBodyString;
    if (rawBody === undefined) {
      rawBody = req.body;
      if (Buffer.isBuffer(rawBody)) {
        rawBody = rawBody.toString("utf-8");
      } else if (rawBody && typeof rawBody === "object") {
        rawBody = JSON.stringify(rawBody);
      } else if (typeof rawBody !== "string") {
        rawBody = String(rawBody || "");
      }
    }
    if (!rawBody) {
      return res
        .status(400)
        .json(errorPayload(req, "INVALID_BODY", "Missing webhook body"));
    }

    const event = constructWebhookEvent(rawBody, sig);

    type = String(event?.type || "");
    const accepted = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
    ]);

    if (!accepted.has(type)) return safe200(res);

    const session = event?.data?.object || {};
    const sessionId = String(session?.id || "");
    if (!sessionId) return safe200(res);

    eventId = String(event?.id || "").trim();
    if (!eventId) return safe200(res);

    webhookEventsTotal.inc({ type, status: "received" });

    const requestId = getRequestId(req);

    const eventRecord = await StripeWebhookEvent.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          eventId,
          status: "received",
        },
        $set: { type, sessionId },
        $inc: { attempts: 1 },
      },
      { new: true, upsert: true }
    );

    if (eventRecord?.attempts > 1) {
      webhookEventsTotal.inc({ type, status: "retry" });
    }

    if (eventRecord?.status === "processed") {
      webhookEventsTotal.inc({ type, status: "duplicate" });
      return safe200(res);
    }

    // Find order by Stripe sessionId (primary lookup)
    let order = await Order.findOne({
      paymentMethod: "stripe",
      "stripe.sessionId": sessionId,
    });

    // ✅ TASK A: Metadata fallback when sessionId lookup fails
    // This handles crash-window scenarios where server stopped before saving sessionId on order
    if (!order) {
      const orderIdFromMeta = String(session?.metadata?.orderId || "").trim();

      if (orderIdFromMeta && mongoose.Types.ObjectId.isValid(orderIdFromMeta)) {
        // Find order by metadata orderId with strict guard rails
        const fallbackOrder = await Order.findOne({
          _id: orderIdFromMeta,
          paymentMethod: "stripe",
          status: { $in: [...SAFE_FALLBACK_STATUSES] },
        });

        if (fallbackOrder) {
          // Best-effort: persist sessionId + paymentIntentId on order BEFORE continuing
          const paymentIntentIdFromSession = session?.payment_intent
            ? String(session.payment_intent)
            : "";

          await Order.updateOne(
            { _id: fallbackOrder._id },
            {
              $set: {
                "stripe.sessionId": sessionId,
                ...(paymentIntentIdFromSession
                  ? { "stripe.paymentIntentId": paymentIntentIdFromSession }
                  : {}),
              },
            }
          ).catch((e) => {
            req.log.warn(
              { err: String(e?.message || e) },
              "[stripe.webhook] best-effort sessionId persist failed"
            );
          });

          order = fallbackOrder;

          logMetadataFallback({
            requestId,
            sessionId,
            orderId: orderIdFromMeta,
            eventType: type,
            success: true,
            reason: "found_by_metadata_orderId",
          });
        } else {
          logMetadataFallback({
            requestId,
            sessionId,
            orderId: orderIdFromMeta,
            eventType: type,
            success: false,
            reason: "order_not_found_or_invalid_status",
          });
        }
      }
    }

    // Always 200 (do not leak)
    if (!order) {
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "failed",
            failureStep: "order_lookup",
            lastError: "Order not found for session",
            lastErrorAt: new Date(),
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
      return safe200(res);
    }

    /**
     * ✅ Lock-only single-writer guard (no side effects before this)
     */
    const now = new Date();
    lockId = String(event?.id || new mongoose.Types.ObjectId());
    const staleBefore = new Date(
      now.getTime() - WEBHOOK_LOCK_STALE_MINUTES * 60 * 1000
    );
    const locked = await Order.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ["pending_payment", "paid"] },
        paymentMethod: "stripe",
        "stripe.sessionId": sessionId,
        "webhook.processedAt": null,
        $or: [
          { "webhook.lockId": { $exists: false } },
          { "webhook.lockId": "" },
          { "webhook.lockId": null },
          { "webhook.lockedAt": null },
          { "webhook.lockedAt": { $lte: staleBefore } },
        ],
      },
      { $set: { "webhook.lockId": lockId, "webhook.lockedAt": now } },
      { new: true }
    );

    if (!locked) {
      const alreadyProcessed = await Order.findOne({
        _id: order._id,
        "webhook.processedAt": { $ne: null },
      }).select("_id");

      if (alreadyProcessed) {
        webhookEventsTotal.inc({ type, status: "duplicate" });
        await StripeWebhookEvent.updateOne(
          { eventId },
          {
            $set: {
              status: "processed",
              processedAt: new Date(),
              orderId: order._id,
              lockId: "",
              lockedAt: null,
            },
          }
        ).catch(() => {});
        return safe200(res);
      }

      webhookEventsTotal.inc({ type, status: "locked" });
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            orderId: order._id,
            failureStep: "order_lock_busy",
            lastError: "Order lock already held",
            lastErrorAt: new Date(),
          },
        }
      ).catch(() => {});

      return res.status(409).json(errorPayload(req, "WEBHOOK_LOCKED", "Webhook is already processing"));
    }
    lockedOrderId = locked._id;

    await StripeWebhookEvent.updateOne(
      { eventId },
      {
        $set: {
          status: "processing",
          lockId,
          lockedAt: now,
          orderId: locked._id,
        },
      }
    ).catch(() => {});

    await releaseExpiredReservations().catch((e) => {
      req.log.warn({ err: String(e?.message || e) }, "[best-effort] stripe webhook release expired reservations failed");
    });

    // async failed => cancel (no stock changes)
    if (type === "checkout.session.async_payment_failed") {
      await releaseStockReservation({ orderId: locked._id }).catch((e) => {
        req.log.warn({ err: String(e?.message || e) }, "[best-effort] stripe webhook release stock reservation failed");
      });
      const couponCode = normalizeCoupon(
        locked?.pricing?.discounts?.coupon?.code || locked?.pricing?.couponCode,
      );
      if (couponCode) {
        await releaseCouponReservation({ code: couponCode, orderId: locked._id }).catch((e) => {
          req.log.warn({ err: String(e?.message || e) }, "[best-effort] stripe webhook release coupon reservation failed");
        });
        await Order.updateOne(
          { _id: locked._id },
          { $set: { "couponReservation.status": "released" } }
        );
      }
      await Order.updateOne(
        { _id: locked._id, status: "pending_payment" },
        {
          $set: {
            status: "cancelled",
            internalNote: "Stripe async payment failed",
          },
        },
      );
      await Order.updateOne(
        { _id: locked._id, "webhook.lockId": lockId },
        { $set: { "webhook.processedAt": new Date(), "webhook.lockId": "", "webhook.lockedAt": null } }
      ).catch(() => {});
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "processed",
            processedAt: new Date(),
            failureStep: "async_payment_failed",
            lastError: "Stripe async payment failed",
            lastErrorAt: new Date(),
            orderId: locked._id,
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
      return safe200(res);
    }

    // For completed/async_succeeded, ensure it's actually paid
    const paymentStatus = String(session?.payment_status || "").toLowerCase();
    if (paymentStatus && paymentStatus !== "paid") {
      await releaseWebhookLock(locked._id, lockId);
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "processed",
            processedAt: new Date(),
            failureStep: "payment_status_not_paid",
            lastError: `payment_status=${paymentStatus}`,
            lastErrorAt: new Date(),
            orderId: locked._id,
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
      return safe200(res);
    }

    const paymentIntentId = session?.payment_intent ? String(session.payment_intent) : "";

    /**
     * ✅ CRITICAL: Verify paid amount/currency matches order.pricing.totalMinor
     * Prevents payment manipulation attacks where attacker pays less than expected
     */
    const amountVerification = verifyPaymentAmount(session, locked);
    if (!amountVerification.valid) {
      webhookEventsTotal.inc({ type, status: "error" });
      onWebhookFailure({ requestId, type, status: "error", reason: amountVerification.reason || "amount_verification_failed" });
      req.log.error({ requestId, type, reason: amountVerification.reason, message: amountVerification.message }, "[stripe.webhook] AMOUNT VERIFICATION FAILED");
      logWebhookFailure({
        req,
        eventId,
        orderId: locked._id,
        step: "amount_verification_failed",
        error: amountVerification.message,
      });
      await markReservationInvalidAndRefund(
        locked,
        paymentIntentId,
        "fraud",
        `Payment amount verification failed: ${amountVerification.message}`
      );
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "processed",
            processedAt: new Date(),
            failureStep: "amount_verification_failed",
            lastError: amountVerification.message,
            lastErrorAt: new Date(),
            orderId: locked._id,
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
      await Order.updateOne(
        { _id: locked._id, "webhook.lockId": lockId },
        { $set: { "webhook.processedAt": new Date(), "webhook.lockId": "", "webhook.lockedAt": null } }
      ).catch(() => {});
      return safe200(res);
    }

    const reservation = await confirmStockReservation({ orderId: locked._id, now });
    if (!reservation) {
      webhookEventsTotal.inc({ type, status: "error" });
      onWebhookFailure({ requestId, type, status: "error", reason: "out_of_stock" });
      logWebhookFailure({
        req,
        eventId,
        orderId: locked._id,
        step: "stock_reservation_missing",
        error: "No valid stock reservation at payment confirmation",
      });
      await markReservationInvalidAndRefund(locked, paymentIntentId, "out_of_stock", "No valid stock reservation at payment confirmation");
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "processed",
            processedAt: new Date(),
            failureStep: "stock_reservation_missing",
            lastError: "No valid stock reservation at payment confirmation",
            lastErrorAt: new Date(),
            orderId: locked._id,
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
      await Order.updateOne(
        { _id: locked._id, "webhook.lockId": lockId },
        { $set: { "webhook.processedAt": new Date(), "webhook.lockId": "", "webhook.lockedAt": null } }
      ).catch(() => {});
      return safe200(res);
    }

    /**
     * Finalize paid status only AFTER amount + stock succeed
     */
    let paidOrder = locked;
    if (locked.status === "pending_payment") {
      const paidUpdate = {
        status: "paid",
        "stripe.paymentIntentId": paymentIntentId,
        ...(locked.paidAt ? {} : { paidAt: now }),
      };

      paidOrder = await Order.findOneAndUpdate(
        { _id: locked._id, status: "pending_payment", "webhook.lockId": lockId },
        { $set: paidUpdate },
        { new: true }
      );

      if (!paidOrder) return safe200(res);
    } else {
      const paidUpdate = {};
      if (paymentIntentId && !locked?.stripe?.paymentIntentId) {
        paidUpdate["stripe.paymentIntentId"] = paymentIntentId;
      }
      if (!locked?.paidAt) paidUpdate.paidAt = now;
      if (Object.keys(paidUpdate).length > 0) {
        await Order.updateOne(
          { _id: locked._id, "webhook.lockId": lockId },
          { $set: paidUpdate }
        );
        if (paymentIntentId) locked.stripe.paymentIntentId = paymentIntentId;
        if (!locked.paidAt) locked.paidAt = now;
      }
    }

    /**
     * Store receipt URL + chargeId (best-effort)
     */
    if (paymentIntentId) {
      try {
        const pi = await retrievePaymentIntent(paymentIntentId);
        const { chargeId, receiptUrl } = extractChargeAndReceiptFromPI(pi);

        await Order.updateOne(
          { _id: paidOrder._id },
          {
            $set: {
              "stripe.chargeId": chargeId || "",
              "stripe.receiptUrl": receiptUrl || "",
              "invoice.provider": receiptUrl ? "stripe" : paidOrder?.invoice?.provider || "none",
            },
          },
        );
      } catch (e) {
        req.log.warn({ err: String(e?.message || e) }, "[stripe.webhook] receipt extraction failed");
      }
    }

    /**
     * Payment ledger: idempotent insert (duplicate eventId/transactionId => no-op)
     */
    const amountMinor = Math.round(Number(paidOrder?.pricing?.totalMinor ?? session?.amount_total ?? 0));
    const payload = {
      transactionId: paymentIntentId,
      type: "payment",
      orderId: paidOrder._id,
      userId: paidOrder.userId || null,
      amountMinor,
      currency: String(paidOrder?.currency || session?.currency || "ils").toLowerCase(),
      status: "succeeded",
      provider: "stripe",
      rawEventHash: eventId ? eventId.slice(0, 64) : "",
    };
    if (eventId) payload.eventId = eventId;
    try {
      await Payment.create(payload);
    } catch (ledgerErr) {
      if (ledgerErr?.code !== 11000) {
        req.log.warn({ err: String(ledgerErr?.message || ledgerErr) }, "[stripe.webhook] payment ledger insert failed");
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
      paidOrder?.pricing?.discounts?.coupon?.code || paidOrder?.pricing?.couponCode,
    );

    if (couponCode) {
      const couponResult = await consumeReservedCoupon({
        code: couponCode,
        orderId: paidOrder._id,
        userId: paidOrder.userId ?? null,
        discountAmount: Number(paidOrder?.pricing?.discounts?.coupon?.amount ?? 0),
      });
      if (!couponResult.success && !couponResult.alreadyUsed) {
        webhookEventsTotal.inc({ type, status: "error" });
        onWebhookFailure({ requestId, type, status: "error", reason: "coupon_consume_failed" });
        req.log.warn({ error: couponResult.error }, "[stripe.webhook] Coupon consume failed");
        logWebhookFailure({
          req,
          eventId,
          orderId: paidOrder._id,
          step: "coupon_consume_failed",
          error: couponResult.error || "coupon consume failed",
        });
        await markReservationInvalidAndRefund(
          paidOrder,
          paymentIntentId,
          "other",
          `Coupon reservation invalid: ${couponResult.error || "unknown"}`
        );
        await StripeWebhookEvent.updateOne(
          { eventId },
          {
            $set: {
              status: "processed",
              processedAt: new Date(),
              failureStep: "coupon_consume_failed",
              lastError: String(couponResult.error || "coupon consume failed"),
              lastErrorAt: new Date(),
              orderId: paidOrder._id,
              lockId: "",
              lockedAt: null,
            },
          }
        ).catch(() => {});
        await Order.updateOne(
          { _id: paidOrder._id, "webhook.lockId": lockId },
          { $set: { "webhook.processedAt": new Date(), "webhook.lockId": "", "webhook.lockedAt": null } }
        ).catch(() => {});
        return safe200(res);
      }

      await Order.updateOne(
        { _id: paidOrder._id },
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
    await clearPurchasedItemsFromCart(paidOrder.userId, paidOrder.items);

    /**
     * Move order to confirmed after stock is successfully decremented
     * paid = payment captured
     * confirmed = stock allocated + order ready for fulfillment
     */
    await Order.updateOne({ _id: paidOrder._id, status: "paid" }, { $set: { status: "confirmed" } });

    // ✅ Record sales counters (idempotent)
    await recordOrderSale(paidOrder, { now }).catch(() => {});

    await issueInvoiceWithLock(paidOrder._id, {
      idempotencyKey: buildInvoiceIdempotencyKey(paidOrder),
    }).catch((e) => {
      req.log.warn({ err: String(e?.message || e), orderId: paidOrder._id }, "[stripe.webhook] invoice best-effort failed");
    });

    await Order.updateOne(
      { _id: paidOrder._id, "webhook.lockId": lockId },
      { $set: { "webhook.processedAt": new Date(), "webhook.lockId": "", "webhook.lockedAt": null } }
    );
    await StripeWebhookEvent.updateOne(
      { eventId },
      {
        $set: {
          status: "processed",
          processedAt: new Date(),
          orderId: paidOrder._id,
          lockId: "",
          lockedAt: null,
        },
      }
    ).catch(() => {});

    webhookEventsTotal.inc({ type, status: "success" });
    return safe200(res);
  } catch (err) {
    if (lockedOrderId && lockId) {
      await releaseWebhookLock(lockedOrderId, lockId);
    }
    if (eventId) {
      await StripeWebhookEvent.updateOne(
        { eventId },
        {
          $set: {
            status: "failed",
            failureStep: "exception",
            lastError: String(err?.message || err),
            lastErrorAt: new Date(),
            orderId: lockedOrderId || null,
            lockId: "",
            lockedAt: null,
          },
        }
      ).catch(() => {});
    }
    logWebhookFailure({
      req,
      eventId,
      orderId: lockedOrderId,
      step: "exception",
      error: err,
    });
    webhookEventsTotal.inc({ type, status: "error" });
    onWebhookFailure({ requestId: getRequestId(req), type, status: "error", reason: String(err?.message || err) });
    req.log.error({ err: String(err?.message || err), requestId: getRequestId(req) }, "[stripe.webhook] error");
    // Stripe will retry on non-2xx; we return 400 only for signature/event parsing issues
    return res
      .status(400)
      .json(errorPayload(req, "INVALID_STRIPE_SIGNATURE", `Webhook Error: ${err?.message || "Unknown error"}`));
  }
});

export default router;
