// src/services/refund.service.js
import Stripe from "stripe";
import mongoose from "mongoose";
import { ENV } from "../utils/env.js";
import { Order } from "../models/Order.js";
import { RefundRequest } from "../models/RefundRequest.js";
import { refundRestoreStockBulk, releaseReservedStockBulk } from "./stock.service.js";
import { assertOrderTransition } from "../utils/orderState.js";
import { mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { formatOrderForResponse } from "../utils/orderResponse.js";

import { logAdminAction, AuditActions } from "./audit.service.js";
import { enqueueOrderNotification } from "./notification.service.js";

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY);

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function safeStr(v, max = 300) {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function requireIdempotencyKey(req) {
  const k = req.headers["idempotency-key"];
  if (!k || typeof k !== "string" || k.trim().length < 8) {
    throw httpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }
  return k.trim();
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

function formatRefundRequest(docOrLean) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;
  const currency = normalizeCurrency(d.currency);
  return {
    ...d,
    ...mapMoneyPairFromMinor(Number.isInteger(d.amount) ? d.amount : 0, currency, "amount", "amountMinor"),
    currency,
  };
}

function daysToMs(days) {
  return Number(days) * 24 * 60 * 60_000;
}

async function auditRefundEvent({
  ctx,
  stage, // "attempt" | "success" | "fail"
  orderId,
  refundRequestId,
  stripeRefundId,
  amount,
  currency,
  reason,
  restock,
  error,
}) {
  const outcome = stage === "fail" ? "failure" : "success";
  const errMsg = error ? String(error?.message || error).slice(0, 500) : null;

  await logAdminAction({
    actorId: ctx?.actorId || null,
    actorRoles: Array.isArray(ctx?.roles) ? ctx.roles : [],
    actorEmail: ctx?.email || null,

    action: "order.refund",
    event: AuditActions.ADMIN_ORDER_REFUND,

    entityType: "Order",
    entityId: String(orderId || ""),

    requestId: ctx?.requestId || null,
    ip: ctx?.ip || null,
    userAgent: ctx?.userAgent || null,

    outcome,
    statusCode: ctx?.statusCode || null,
    message:
      stage === "attempt"
        ? "Refund attempt"
        : stage === "success"
          ? "Refund success"
          : "Refund failed",

    meta: {
      stage,
      refundRequestId: refundRequestId ? String(refundRequestId) : null,
      stripeRefundId: stripeRefundId ? String(stripeRefundId) : null,
      amount: Number.isFinite(Number(amount)) ? Number(amount) : null,
      currency: currency ? String(currency) : null,
      reason: reason ? safeStr(reason, 200) : null,
      restock: restock === true,
      ...(errMsg ? { error: errMsg } : {}),
    },
  });
}

/**
 * Admin refund (hardened):
 * - Strong idempotency via RefundRequest unique key (orderId + key)
 * - Locks/concurrency control via transaction + conditional order update
 * - Audit hooks for attempt/success/failure including target ids
 * - Keeps Stripe idempotencyKey aligned with client key (critical)
 *
 * Requirements:
 * - RefundRequest should have UNIQUE index on { orderId: 1, key: 1 }
 * - Mongo replica set for transactions (recommended for admin money ops)
 */
export async function adminRefundOrder({ req, orderId, actorId, body, ctx } = {}) {
  const key = requireIdempotencyKey(req);
  const orderObjectId = new mongoose.Types.ObjectId(orderId);

  // 1) Read order (lean not required; we will later update)
  const order = await Order.findById(orderObjectId);
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  const allowedStatuses = [
    "paid",
    "stock_confirmed",
    "fulfilled",
    "partially_refunded",
    "payment_received",
  ];
  if (!allowedStatuses.includes(order.status)) {
    throw httpError(409, "REFUND_NOT_ALLOWED", "Refund is not allowed in current status", {
      status: order.status,
    });
  }

  // Refund window policy
  const maxDays = Number(ENV.REFUND_MAX_DAYS || 14);
  if (order?.payment?.paidAt) {
    const paidAt = new Date(order.payment.paidAt).getTime();
    const deadline = paidAt + daysToMs(maxDays);
    if (Date.now() > deadline) {
      throw httpError(409, "REFUND_WINDOW_EXPIRED", "Refund window expired");
    }
  }

  const allowPartial = ENV.REFUND_ALLOW_PARTIAL !== "false";

  const currency = order?.pricing?.currency || ENV.STRIPE_CURRENCY || "ILS";
  const paidTotal = Number(order?.pricing?.grandTotal || 0); // expects minor units
  const alreadyRefunded = Number(order?.refund?.amountRefunded || 0); // minor units

  if (!Number.isInteger(paidTotal) || paidTotal < 0) {
    throw httpError(409, "INVALID_ORDER_TOTAL", "Invalid order total");
  }
  if (!Number.isInteger(alreadyRefunded) || alreadyRefunded < 0) {
    throw httpError(409, "INVALID_REFUND_STATE", "Invalid refund state");
  }

  const refundable = Math.max(0, paidTotal - alreadyRefunded);
  if (refundable <= 0) throw httpError(409, "NOTHING_TO_REFUND", "Nothing to refund");

  if (!allowPartial && body.amount !== undefined) {
    throw httpError(409, "PARTIAL_REFUNDS_DISABLED", "Partial refunds are disabled");
  }

  const amount = body.amount ?? refundable;
  if (!isPositiveInt(amount)) {
    throw httpError(400, "INVALID_REFUND_AMOUNT", "Refund amount must be a positive integer");
  }
  if (amount > refundable) {
    throw httpError(400, "REFUND_EXCEEDS_REFUNDABLE", "Refund exceeds refundable amount");
  }

  const pi = order?.payment?.stripePaymentIntentId;
  if (!pi) throw httpError(409, "MISSING_PAYMENT_INTENT", "Missing payment intent");

  const reason = safeStr(body.reason || "");
  const defaultRestock = ENV.REFUND_DEFAULT_RESTOCK === "true";
  const restock = body.restock ?? defaultRestock;

  // 2) Idempotent RefundRequest record
  //    If the same (orderId + key) repeats:
  //    - succeeded => return idempotent success
  //    - processing/created => treat as in-progress (409) OR allow client to retry later with same key
  //    - failed => 409 to force new key (prevents loops)
  let rr = null;
  try {
    rr = await RefundRequest.create({
      orderId: order._id,
      key,
      actorId,
      amount,
      currency,
      reason,
      restock: Boolean(restock),
      status: "created",
      requestId: ctx?.requestId || null,
    });
  } catch (e) {
    // assume unique constraint (orderId+key). If not present, add it in the model/index.
    const existing = await RefundRequest.findOne({ orderId: order._id, key }).lean();
    if (existing?.status === "succeeded") {
      await auditRefundEvent({
        ctx,
        stage: "success",
        orderId: String(order._id),
        refundRequestId: String(existing._id),
        stripeRefundId: existing.stripeRefundId || null,
        amount: existing.amount,
        currency: existing.currency,
        reason: existing.reason,
        restock: existing.restock,
        error: null,
      });
      return { ok: true, idempotent: true, refund: formatRefundRequest(existing) };
    }
    if (existing?.status === "failed") {
      await auditRefundEvent({
        ctx,
        stage: "fail",
        orderId: String(order._id),
        refundRequestId: String(existing._id),
        stripeRefundId: existing.stripeRefundId || null,
        amount: existing.amount,
        currency: existing.currency,
        reason: existing.reason,
        restock: existing.restock,
        error: existing.error || "REFUND_PREVIOUSLY_FAILED",
      });
      throw httpError(409, "REFUND_PREVIOUSLY_FAILED", "Previous refund attempt failed");
    }
    if (existing?.status === "created" || existing?.status === "processing") {
      throw httpError(409, "REFUND_IN_PROGRESS", "Refund is already in progress");
    }

    // fallback to non-lean doc for updates
    rr = await RefundRequest.findOne({ orderId: order._id, key });
  }

  // Mark as processing early (best-effort)
  await RefundRequest.updateOne(
    { _id: rr._id, status: "created" },
    { $set: { status: "processing", startedAt: new Date() } },
  );

  await auditRefundEvent({
    ctx,
    stage: "attempt",
    orderId: String(order._id),
    refundRequestId: String(rr._id),
    stripeRefundId: null,
    amount,
    currency,
    reason,
    restock: Boolean(restock),
    error: null,
  });

  // 3) Stripe refund (idempotent with SAME key)
  //    Important: do Stripe call OUTSIDE transaction.
  let stripeRefund = null;
  try {
    stripeRefund = await stripe.refunds.create(
      {
        payment_intent: pi,
        amount,
        metadata: {
          orderId: String(order._id),
          refundRequestId: String(rr._id),
          actorId: String(actorId || ""),
        },
      },
      { idempotencyKey: key },
    );
  } catch (e) {
    await RefundRequest.updateOne(
      { _id: rr._id },
      {
        $set: {
          status: "failed",
          error: safeStr(e?.message || "STRIPE_REFUND_FAILED", 500),
          finishedAt: new Date(),
        },
      },
    );

    await auditRefundEvent({
      ctx,
      stage: "fail",
      orderId: String(order._id),
      refundRequestId: String(rr._id),
      stripeRefundId: null,
      amount,
      currency,
      reason,
      restock: Boolean(restock),
      error: safeStr(e?.message || "STRIPE_REFUND_FAILED", 500),
    });

    throw httpError(502, "REFUND_FAILED", "Refund failed");
  }

  // 4) Commit DB updates atomically (order + refund request status)
  const session = await mongoose.startSession();
  let updatedOrder = null;

  try {
    await session.withTransaction(async () => {
      // Re-read the refund state inside the transaction to reduce race impact
      const fresh = await Order.findById(order._id).session(session);
      if (!fresh) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

      const freshPaidTotal = Number(fresh?.pricing?.grandTotal || 0);
      const freshAlreadyRefunded = Number(fresh?.refund?.amountRefunded || 0);

      if (!Number.isInteger(freshPaidTotal) || freshPaidTotal < 0) {
        throw httpError(409, "INVALID_ORDER_TOTAL", "Invalid order total");
      }
      if (!Number.isInteger(freshAlreadyRefunded) || freshAlreadyRefunded < 0) {
        throw httpError(409, "INVALID_REFUND_STATE", "Invalid refund state");
      }

      const freshRefundable = Math.max(0, freshPaidTotal - freshAlreadyRefunded);
      if (amount > freshRefundable) {
        // This can happen if two refunds were processed in parallel.
        throw httpError(409, "REFUND_RACE_DETECTED", "Refund race detected");
      }

      const nextRefunded = freshAlreadyRefunded + amount;
      const nextOrderStatus = nextRefunded >= freshPaidTotal ? "refunded" : "partially_refunded";

      assertOrderTransition(fresh.status, nextOrderStatus);

      // Conditional update: compare amountRefunded to prevent concurrent double-updates
      updatedOrder = await Order.findOneAndUpdate(
        {
          _id: fresh._id,
          status: { $in: allowedStatuses },
          "refund.amountRefunded": freshAlreadyRefunded,
        },
        {
          $set: {
            status: nextOrderStatus,
            "refund.status": nextRefunded >= freshPaidTotal ? "full" : "partial",
            "refund.refundedAt": new Date(),
            "refund.lastStripeRefundId": stripeRefund.id,
          },
          $inc: { "refund.amountRefunded": amount },
        },
        { new: true, session },
      );

      if (!updatedOrder) {
        throw httpError(409, "REFUND_RACE_DETECTED", "Refund race detected");
      }

      await RefundRequest.updateOne(
        { _id: rr._id },
        {
          $set: {
            status: "succeeded",
            stripeRefundId: stripeRefund.id,
            finishedAt: new Date(),
          },
        },
        { session },
      );
    });
  } catch (e) {
    // DB commit failed AFTER Stripe success. Mark request as failed with explicit reason.
    await RefundRequest.updateOne(
      { _id: rr._id },
      {
        $set: {
          status: "failed",
          error: safeStr(e?.code || e?.message || "DB_COMMIT_FAILED", 500),
          stripeRefundId: stripeRefund?.id || null,
          finishedAt: new Date(),
        },
      },
    );

    await auditRefundEvent({
      ctx,
      stage: "fail",
      orderId: String(order._id),
      refundRequestId: String(rr._id),
      stripeRefundId: stripeRefund?.id || null,
      amount,
      currency,
      reason,
      restock: Boolean(restock),
      error: safeStr(e?.code || e?.message || "DB_COMMIT_FAILED", 500),
    });

    // At this point, Stripe has refunded but DB didn't finalize.
    // This is serious; surface a 502 with a specific code for ops handling.
    throw httpError(502, "REFUND_DB_FINALIZATION_FAILED", "Refund succeeded but finalization failed");
  } finally {
    session.endSession();
  }

  // 5) Restock/release policy (best-effort, but audit outcome)
  // Keep outside transaction; stock operations may be heavy/side-effecty.
  try {
    const canRestock = updatedOrder.stock?.status === "confirmed";
    const nextRefunded = Number(updatedOrder?.refund?.amountRefunded || 0);
    const nextPaidTotal = Number(updatedOrder?.pricing?.grandTotal || 0);

    if (restock) {
      if (canRestock && nextRefunded >= nextPaidTotal) {
        await refundRestoreStockBulk(updatedOrder._id, updatedOrder.items, { mode: "full_refund" });
        await Order.updateOne(
          { _id: updatedOrder._id },
          { $set: { "refund.restocked": true } },
        );
      } else if (canRestock && Array.isArray(body.restockItems) && body.restockItems.length) {
        await refundRestoreStockBulk(updatedOrder._id, body.restockItems, { mode: "partial_refund" });
      } else if (!canRestock && updatedOrder.stock?.status === "reserved") {
        // release reserved stock (best-effort)
        await releaseReservedStockBulk(updatedOrder._id, updatedOrder.items || [], {
          requireActive: false,
          reason: "refund_release",
          allowLegacy: true,
        });
        await Order.updateOne(
          { _id: updatedOrder._id },
          { $set: { "stock.status": "released", "stock.releasedAt": new Date() } },
        );
      }
    }
  } catch (e) {
    // Best effort: do not block refund success.
    await RefundRequest.updateOne(
      { _id: rr._id },
      {
        $set: {
          restockError: safeStr(e?.message || "RESTOCK_FAILED", 500),
        },
      },
    );
  }

  await auditRefundEvent({
    ctx,
    stage: "success",
    orderId: String(updatedOrder._id),
    refundRequestId: String(rr._id),
    stripeRefundId: stripeRefund.id,
    amount,
    currency,
    reason,
    restock: Boolean(restock),
    error: null,
  });

  // Best-effort notification (do not block refund success)
  void enqueueOrderNotification({
    orderId: updatedOrder._id,
    event: "order_refunded",
    dedupeKey: `notify:order_refunded:${String(updatedOrder._id)}:${String(rr._id)}`,
    meta: { refundRequestId: String(rr._id), stripeRefundId: stripeRefund.id },
  }).catch(() => {});

  return {
    ok: true,
    refundId: stripeRefund.id,
    order: formatOrderForResponse(updatedOrder.toObject ? updatedOrder.toObject() : updatedOrder),
  };
}
