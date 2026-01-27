// src/services/refunds.service.js
import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { createStripeRefund } from "./stripe.service.js";
import { evaluateReturnEligibility, computeReturnRefundAmountMajor } from "../utils/returns.policy.js";

/* ============================
   Helpers
============================ */

function makeErr(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function clampMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function defaultIdempotencyKey(orderId, paymentIntentId, tag = "refund:admin") {
  return `${tag}:${String(orderId)}:${String(paymentIntentId || "")}`.slice(0, 200);
}

function normalizeReason(reason) {
  const r = String(reason || "other");
  const allowed = new Set(["customer_cancel", "return", "out_of_stock", "fraud", "duplicate", "other"]);
  return allowed.has(r) ? r : "other";
}

function calcIsPartial(amountMajor, totalMajor) {
  const a = clampMoney(amountMajor);
  const t = clampMoney(totalMajor);
  if (a <= 0) return false;
  if (t <= 0) return false;
  return a < t;
}

/* ============================
   Core: Refund Stripe Order
============================ */

/**
 * Refund Stripe order (full or partial).
 *
 * - idempotent: uses order.idempotency.refundKey if provided
 * - updates Order.refund + Order.status
 */
export async function refundStripeOrder({
  orderId,
  amountMajor, // optional (ILS major)
  reason = "other",
  note = "",
  idempotencyKey = "",
}) {
  if (!orderId) throw makeErr(400, "MISSING_ORDER_ID", "orderId is required");
  if (!isValidObjectId(orderId)) throw makeErr(400, "INVALID_ID", "Invalid orderId");

  const order = await Order.findById(orderId);
  if (!order) throw makeErr(404, "NOT_FOUND", "Order not found");

  if (order.paymentMethod !== "stripe") {
    throw makeErr(400, "REFUND_NOT_SUPPORTED", "Refunds are only supported for Stripe orders");
  }

  const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
  if (!paymentIntentId) {
    throw makeErr(400, "MISSING_PAYMENT_INTENT", "Order has no paymentIntentId");
  }

  const totalMajor = clampMoney(order?.pricing?.total ?? 0);
  const desiredAmount = typeof amountMajor === "number" ? clampMoney(amountMajor) : undefined;

  if (typeof desiredAmount === "number" && desiredAmount > totalMajor) {
    throw makeErr(400, "AMOUNT_EXCEEDS_TOTAL", "Refund amount cannot exceed order total");
  }

  // If already refunded fully
  if (order?.refund?.status === "succeeded" && order.status === "refunded") {
    return order;
  }

  // Idempotency: if the same refundKey already succeeded, return order
  const idemKey =
    String(idempotencyKey || "").trim() ||
    String(order?.idempotency?.refundKey || "").trim() ||
    defaultIdempotencyKey(order._id, paymentIntentId, "refund:admin");

  if (
    String(order?.idempotency?.refundKey || "") === idemKey &&
    String(order?.refund?.status || "") === "succeeded"
  ) {
    return order;
  }

  const normReason = normalizeReason(reason);

  // Mark pending first
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        status: "refund_pending",
        "refund.status": "pending",
        "refund.reason": normReason,
        "refund.requestedAt": new Date(),
        ...(idemKey ? { "idempotency.refundKey": idemKey } : {}),
        ...(note ? { internalNote: String(note).slice(0, 400) } : {}),
      },
    }
  );

  // Execute Stripe refund
  try {
    const refund = await createStripeRefund({
      paymentIntentId,
      amountMajor: typeof desiredAmount === "number" ? desiredAmount : undefined,
      reason: normReason,
      idempotencyKey: idemKey,
    });

    const refundAmount = typeof desiredAmount === "number" ? desiredAmount : totalMajor;
    const isPartial = calcIsPartial(refundAmount, totalMajor);

    const updated = await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: isPartial ? "partially_refunded" : "refunded",
          "refund.status": "succeeded",
          "refund.amount": refundAmount,
          "refund.currency": "ils",
          "refund.stripeRefundId": String(refund?.id || ""),
          "refund.refundedAt": new Date(),
          ...(note ? { internalNote: String(note).slice(0, 400) } : {}),
        },
      },
      { new: true }
    );

    return updated;
  } catch (e) {
    const updated = await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: "refund_pending",
          "refund.status": "failed",
          "refund.failureMessage": String(e?.message || "Refund failed").slice(0, 400),
          ...(note ? { internalNote: String(note).slice(0, 400) } : {}),
        },
      },
      { new: true }
    );

    // Let route decide response status
    throw makeErr(502, "REFUND_FAILED", "Stripe refund failed", { order: updated });
  }
}

/* ============================
   Return -> Refund helper
============================ */

/**
 * Refund an order due to a RETURN process.
 * - validates policy first (window, status, etc.)
 * - optional returnItems to compute partial amount
 */
export async function refundOrderForReturn({
  orderId,
  returnItems = null, // optional [{productId, qty}]
  includeShipping = false, // usually false in Israel unless policy says otherwise
  note = "",
  idempotencyKey = "",
}) {
  if (!orderId) throw makeErr(400, "MISSING_ORDER_ID", "orderId is required");

  const order = await Order.findById(orderId);
  if (!order) throw makeErr(404, "NOT_FOUND", "Order not found");

  const policy = evaluateReturnEligibility(order);
  if (!policy.eligible) {
    throw makeErr(400, policy.code || "RETURN_NOT_ALLOWED", policy.message || "Return not allowed");
  }

  // compute refund amount from return items
  const amountMajor = computeReturnRefundAmountMajor({
    order,
    returnItems,
    includeShipping,
  });

  // if returnItems => partial refund likely; if null => full refund
  return await refundStripeOrder({
    orderId: order._id,
    amountMajor,
    reason: "return",
    note: note || "Refund due to return request",
    idempotencyKey: idempotencyKey || "",
  });
}
