// src/services/admin-orders.service.js
// Single source of truth for admin order operations.
// Used by both admin.routes.js (legacy) and admin.orders.routes.js.

import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { Payment } from "../models/Payment.js";
import { createStripeRefund } from "./stripe.service.js";
import {
  createInvoiceForOrder,
  resolveInvoiceProvider,
  recordInvoiceIssueMetric,
} from "./invoice.service.js";
import { computeAllocationRequirement } from "../utils/allocation.js";
import { mapOrder } from "../utils/mapOrder.js";
import { releaseCouponReservation } from "./pricing.service.js";
import {
  recordOrderSale,
  recordOrderRefund,
  rankingConfig,
} from "./ranking.service.js";
import { getRefundOperationsCounter } from "../middleware/prometheus.js";
import { sendRefundNotificationSafe } from "./email.service.js";

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

/**
 * Convert variant ID string to ObjectId safely.
 * Returns null if invalid or empty.
 */
function toVariantObjectId(id) {
  const v = String(id || "").trim();
  if (!v) return null;
  return mongoose.Types.ObjectId.isValid(v)
    ? new mongoose.Types.ObjectId(v)
    : null;
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function clampMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function getRefundWindowDays() {
  const direct = Number(process.env.REFUND_WINDOW_DAYS || "");
  if (Number.isFinite(direct) && direct > 0)
    return Math.min(180, Math.max(1, Math.floor(direct)));

  const fallback = Number(process.env.RETURN_WINDOW_DAYS || "");
  if (Number.isFinite(fallback) && fallback > 0)
    return Math.min(180, Math.max(1, Math.floor(fallback)));

  return 30;
}

const REFUND_ALLOWED_STATUSES = new Set([
  "paid",
  "payment_received",
  "confirmed",
  "stock_confirmed",
  "shipped",
  "delivered",
  "return_requested",
  "refund_pending",
  "partially_refunded",
]);

function resolveRefundBaseDate(order) {
  return order?.deliveredAt || order?.paidAt || order?.createdAt || null;
}

async function getTotalRefundedMinor(order) {
  const orderId = order?._id;
  if (!orderId) return 0;

  const [sumDoc] = await Payment.aggregate([
    { $match: { orderId, type: "refund", status: "succeeded" } },
    { $group: { _id: null, total: { $sum: "$amountMinor" } } },
  ]);

  const ledgerTotal = Number(sumDoc?.total || 0);
  const orderRefundMajor =
    order?.refund?.status === "succeeded"
      ? Number(order?.refund?.amount || 0)
      : 0;
  const orderRefundMinor = Math.max(0, Math.round(orderRefundMajor * 100));

  return Math.max(ledgerTotal, orderRefundMinor);
}

function normalizeRefundItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      productId: String(it?.productId || "").trim(),
      variantId:
        it?.variantId != null ? String(it.variantId || "").trim() : null,
      qty: Math.max(1, Math.min(999, Number(it?.qty || 1))),
      amount: typeof it?.amount === "number" ? clampMoney(it.amount) : null,
    }))
    .filter((it) => it.productId);
}

function validateRefundItems({ order, items }) {
  const orderItems = Array.isArray(order?.items) ? order.items : [];
  const byProduct = new Map();

  for (const it of orderItems) {
    const pid = String(it?.productId || "").trim();
    if (!pid) continue;
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(it);
  }

  const usedByKey = new Map();
  let maxRefundable = 0;

  for (const r of items) {
    const pid = String(r.productId || "").trim();
    const list = byProduct.get(pid);
    if (!list || list.length === 0) {
      throw makeErr(
        400,
        "REFUND_ITEM_NOT_FOUND",
        "Refund item not found on order",
      );
    }

    let match = null;
    const vid = r.variantId ? String(r.variantId) : "";
    if (vid) {
      match = list.find((it) => String(it?.variantId || "") === vid);
    } else if (list.length === 1) {
      match = list[0];
    } else {
      throw makeErr(
        400,
        "REFUND_ITEM_AMBIGUOUS",
        "variantId is required for this product",
      );
    }

    if (!match) {
      throw makeErr(
        400,
        "REFUND_ITEM_NOT_FOUND",
        "Refund item not found on order",
      );
    }

    const qty = Math.max(1, Math.min(999, Number(r.qty || 1)));
    const boughtQty = Math.max(1, Math.min(999, Number(match.qty || 1)));
    const key = `${pid}:${String(match.variantId || "")}`;
    const prev = usedByKey.get(key) || { qty: 0, amount: 0 };
    const nextQty = prev.qty + qty;
    if (nextQty > boughtQty) {
      throw makeErr(
        400,
        "REFUND_QTY_EXCEEDS_ORDER",
        "Refund quantity exceeds ordered quantity",
      );
    }

    const unitPrice = clampMoney(match.unitPrice || 0);
    const lineMax = clampMoney(unitPrice * qty);
    const itemAmount = r.amount != null ? clampMoney(r.amount) : lineMax;
    const maxTotalForItem = clampMoney(unitPrice * boughtQty);
    const nextAmount = clampMoney(prev.amount + itemAmount);

    if (itemAmount < 0 || itemAmount > lineMax) {
      throw makeErr(
        400,
        "REFUND_AMOUNT_EXCEEDS_ITEM",
        "Refund amount exceeds item limit",
      );
    }
    if (nextAmount > maxTotalForItem) {
      throw makeErr(
        400,
        "REFUND_AMOUNT_EXCEEDS_ITEM",
        "Refund amount exceeds item limit",
      );
    }

    usedByKey.set(key, { qty: nextQty, amount: nextAmount });
    maxRefundable = clampMoney(maxRefundable + itemAmount);
  }

  return { maxRefundable };
}

/* ============================
   Status State Machine
============================ */

export const ORDER_STATUSES = [
  "pending_payment",
  "pending_cod",
  "cod_pending_approval",
  "paid",
  "payment_received",
  "confirmed",
  "stock_confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "refund_pending",
  "partially_refunded",
  "refunded",
  "return_requested",
];

const VALID_TRANSITIONS = {
  pending_payment: ["paid", "cancelled"],
  pending_cod: ["cod_pending_approval", "confirmed", "cancelled"],
  cod_pending_approval: ["confirmed", "cancelled"],
  paid: [
    "payment_received",
    "confirmed",
    "stock_confirmed",
    "shipped",
    "refund_pending",
    "cancelled",
  ],
  payment_received: [
    "confirmed",
    "stock_confirmed",
    "shipped",
    "refund_pending",
    "cancelled",
  ],
  confirmed: ["stock_confirmed", "shipped", "cancelled", "refund_pending"],
  stock_confirmed: ["shipped", "cancelled", "refund_pending"],
  shipped: ["delivered", "return_requested"],
  delivered: ["return_requested", "refund_pending"],
  return_requested: ["refund_pending", "partially_refunded", "refunded"],
  refund_pending: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
  cancelled: [],
};

export function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/* ============================
   Invoice Best Effort
============================ */

function buildInvoiceIdempotencyKey(order) {
  const pi = String(order?.stripe?.paymentIntentId || "").trim();
  return `invoice:admin:${order?._id}:${pi}`.slice(0, 200);
}

export async function issueInvoiceBestEffort(order) {
  if (!order || !order._id) return;
  if (order?.invoice?.status === "issued") return;

  const idempotencyKey = buildInvoiceIdempotencyKey(order);

  try {
    const invoice = await createInvoiceForOrder(order, { idempotencyKey });
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": invoice.provider,
          "invoice.docId": invoice.docId || "",
          "invoice.providerDocId": invoice.providerDocId || "",
          "invoice.idempotencyKey": idempotencyKey,
          "invoice.docType": invoice.docType || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": invoice.status || "pending",
          "invoice.error": invoice.error || "",
          "invoice.snapshot":
            invoice.raw && typeof invoice.raw === "object" ? invoice.raw : null,
          "invoice.allocation": invoice.allocation || {},
        },
      },
    );
    recordInvoiceIssueMetric("success", "initial");
  } catch (e) {
    const provider = resolveInvoiceProvider(order);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": provider,
          "invoice.docId": String(order._id),
          "invoice.idempotencyKey": idempotencyKey,
          "invoice.number": "",
          "invoice.url": "",
          "invoice.issuedAt": null,
          "invoice.status": "failed",
          "invoice.error": String(e?.message || "Invoice failed").slice(0, 512),
        },
      },
    );
    recordInvoiceIssueMetric("failure", "initial");
  }
}

/* ============================
   Core Order Operations
============================ */

/**
 * Update order status with state machine validation
 * @param {string} orderId
 * @param {string} nextStatus
 * @param {object} options - { validateTransition: boolean, lang: string }
 * @returns {Promise<{order: object, invoiceIssued: boolean}>}
 */
export async function updateOrderStatus(orderId, nextStatus, options = {}) {
  const { validateTransition = true, lang = "he" } = options;

  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  const currentStatus = order.status;

  // Validate state machine transition if enabled
  if (validateTransition && !isValidTransition(currentStatus, nextStatus)) {
    throw makeErr(
      400,
      "INVALID_STATUS_TRANSITION",
      `Cannot transition from "${currentStatus}" to "${nextStatus}"`,
    );
  }

  const update = { status: nextStatus };

  // Auto-set timestamps
  if (
    !order.paidAt &&
    (nextStatus === "paid" || nextStatus === "payment_received")
  ) {
    update.paidAt = new Date();
  }
  if (!order.shippedAt && nextStatus === "shipped") {
    update.shippedAt = new Date();
  }
  if (!order.deliveredAt && nextStatus === "delivered") {
    update.deliveredAt = new Date();
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: update },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  // Check if we should issue invoice for COD orders
  const codPendingStatuses = new Set(["pending_cod", "cod_pending_approval"]);
  const codApprovalStatuses = new Set([
    "confirmed",
    "stock_confirmed",
    "shipped",
    "delivered",
    "paid",
  ]);

  let invoiceIssued = false;
  if (
    order.paymentMethod === "cod" &&
    codPendingStatuses.has(String(currentStatus || "")) &&
    codApprovalStatuses.has(String(nextStatus || ""))
  ) {
    await issueInvoiceBestEffort(updated);
    invoiceIssued = true;
  }

  // ✅ Record sales counters when order reaches a finalized status (idempotent)
  if (rankingConfig?.SALES_STATUSES?.has(String(updated.status || ""))) {
    await recordOrderSale(updated).catch(() => {});
  }

  return { order: updated, invoiceIssued };
}

/**
 * Update shipping information
 */
export async function updateOrderShipping(orderId, shippingData) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  const { carrier, trackingNumber, shippedAt } = shippingData;
  const update = {};

  if (carrier) {
    update["shipping.carrier"] = carrier;
  }
  if (trackingNumber) {
    update["shipping.trackingNumber"] = trackingNumber;
  }
  if (shippedAt) {
    update.shippedAt = new Date(shippedAt);
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: update },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  return updated;
}

/**
 * Build bulkWrite operations for restocking items.
 * Handles both variant and base product stock.
 */
function buildRestockOps(items) {
  const ops = [];
  for (const item of items) {
    const qty = Number(item.qty || 0);
    if (qty <= 0) continue;

    const variantObjId = toVariantObjectId(item.variantId);

    if (variantObjId) {
      // Variant stock restock
      ops.push({
        updateOne: {
          filter: { _id: item.productId, "variants._id": variantObjId },
          update: { $inc: { "variants.$.stock": qty } },
        },
      });
    } else {
      // Base product stock restock
      ops.push({
        updateOne: {
          filter: { _id: item.productId },
          update: { $inc: { stock: qty } },
        },
      });
    }
  }
  return ops;
}

/**
 * Cancel an order with optional restock
 */
export async function cancelOrder(orderId, { reason, restock = false }) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  // Check if already cancelled
  if (order.status === "cancelled") {
    return { order, restocked: false };
  }

  // Check if can be cancelled
  const nonCancellableStatuses = ["delivered", "refunded", "cancelled"];
  if (nonCancellableStatuses.includes(order.status)) {
    throw makeErr(
      400,
      "CANNOT_CANCEL",
      `Order in status "${order.status}" cannot be cancelled`,
    );
  }

  // Restock items if requested
  if (restock) {
    const ops = buildRestockOps(order.items || []);
    if (ops.length > 0) {
      try {
        await Product.bulkWrite(ops, { ordered: false });
      } catch (restockErr) {
        // Log but don't fail cancellation if restock fails
        console.error(
          `[admin-orders] restock failed for order ${orderId}:`,
          String(restockErr?.message || restockErr),
        );
      }
    }
  }

  const update = {
    status: "cancelled",
    "cancellation.requested": true,
    "cancellation.requestedAt": new Date(),
    "cancellation.requestedBy": "admin",
    "cancellation.cancelledAt": new Date(),
    "cancellation.cancelledBy": "admin",
    "cancellation.reason": reason,
  };

  if (order?.couponReservation?.status === "reserved") {
    const code = String(
      order?.pricing?.discounts?.coupon?.code ||
        order?.pricing?.couponCode ||
        "",
    ).trim();
    if (code) {
      await releaseCouponReservation({ code, orderId: order._id }).catch(
        (e) => {
          console.warn(
            "[best-effort] admin cancel release coupon reservation failed:",
            String(e?.message || e),
          );
        },
      );
    }
    update["couponReservation.status"] = "released";
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: update },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  return { order: updated, restocked: Boolean(restock) };
}

/**
 * Process refund for an order (Stripe or COD)
 */
export async function processRefund(
  orderId,
  { amount, reason, note, idempotencyKey, items = null },
) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  const orderTotalMajor = clampMoney(
    order?.pricing?.total ?? order?.total ?? 0,
  );
  const orderTotalMinor = Number.isFinite(Number(order?.pricing?.totalMinor))
    ? Math.max(0, Math.round(Number(order.pricing.totalMinor)))
    : Math.max(0, Math.round(orderTotalMajor * 100));

  const totalRefundedMinor = await getTotalRefundedMinor(order);
  if (order.status === "refunded" || totalRefundedMinor >= orderTotalMinor) {
    return { order, alreadyRefunded: true };
  }

  const status = String(order?.status || "");
  if (!REFUND_ALLOWED_STATUSES.has(status)) {
    throw makeErr(
      400,
      "REFUND_STATUS_NOT_ALLOWED",
      `Refund not allowed for status: ${status}`,
    );
  }

  const baseDate = resolveRefundBaseDate(order);
  if (baseDate) {
    const windowDays = getRefundWindowDays();
    const ageDays = daysBetween(new Date(), baseDate);
    if (ageDays > windowDays) {
      throw makeErr(
        400,
        "REFUND_WINDOW_EXPIRED",
        `Refund window expired (${ageDays} days > ${windowDays} days)`,
      );
    }
  }

  const remainingMinor = Math.max(0, orderTotalMinor - totalRefundedMinor);
  if (remainingMinor <= 0) {
    return { order, alreadyRefunded: true };
  }

  let refundAmount =
    typeof amount === "number" ? clampMoney(amount) : remainingMinor / 100;
  let refundAmountMinor = Math.max(0, Math.round(refundAmount * 100));
  const orderTotal = orderTotalMajor;

  const refundItems = normalizeRefundItems(items);
  let maxRefundable = null;
  if (refundItems.length) {
    ({ maxRefundable } = validateRefundItems({ order, items: refundItems }));
    if (typeof amount !== "number") {
      refundAmount = maxRefundable;
      refundAmountMinor = Math.max(0, Math.round(refundAmount * 100));
    }
  }

  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    throw makeErr(400, "INVALID_REFUND_AMOUNT", "Refund amount must be > 0");
  }
  if (refundAmountMinor > remainingMinor) {
    throw makeErr(
      400,
      "REFUND_CEILING_EXCEEDED",
      "Refund amount exceeds remaining refundable total",
    );
  }

  const isPartial = refundAmount < orderTotal;
  if (isPartial) {
    if (!refundItems.length) {
      throw makeErr(
        400,
        "REFUND_ITEMS_REQUIRED",
        "Refund items are required for partial refunds",
      );
    }
    if (maxRefundable != null && refundAmount > maxRefundable) {
      throw makeErr(
        400,
        "REFUND_AMOUNT_EXCEEDS_ITEMS",
        "Refund amount exceeds refundable items total",
      );
    }
  } else if (refundItems.length && maxRefundable != null) {
    if (refundAmount > maxRefundable) {
      throw makeErr(
        400,
        "REFUND_AMOUNT_EXCEEDS_ITEMS",
        "Refund amount exceeds refundable items total",
      );
    }
  }

  // Handle Stripe refunds
  if (order.paymentMethod === "stripe") {
    const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
    if (!paymentIntentId) {
      throw makeErr(
        400,
        "MISSING_PAYMENT_INTENT",
        "Order has no paymentIntentId",
      );
    }

    // Idempotency guard
    if (
      idempotencyKey &&
      String(order?.idempotency?.refundKey || "") === idempotencyKey
    ) {
      const fresh = await Order.findById(order._id);
      return { order: fresh || order, alreadyRefunded: true };
    }

    // Mark pending
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          status: "refund_pending",
          "refund.status": "pending",
          "refund.reason": reason || "other",
          "refund.requestedAt": new Date(),
          ...(idempotencyKey
            ? { "idempotency.refundKey": idempotencyKey }
            : {}),
          ...(note ? { internalNote: String(note) } : {}),
        },
      },
    );

    try {
      const refund = await createStripeRefund({
        paymentIntentId,
        amountMajor: refundAmount,
        reason: reason || "other",
        idempotencyKey:
          idempotencyKey ||
          `refund:admin:${String(order._id)}:${paymentIntentId}:${refundAmount}`,
      });

      const isPartial =
        refundAmount > 0 && orderTotal > 0 && refundAmount < orderTotal;

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
            ...(note ? { internalNote: String(note) } : {}),
          },
        },
        { new: true },
      );

      /**
       * ✅ DELIVERABLE #4: Update ranking/stats after successful refund
       * Uses analytics.refundCountedAt marker for idempotency
       */
      await recordOrderRefund(updated, {
        refundAmountMinor: Math.round(refundAmount * 100),
        reason: reason || "other",
      }).catch((e) => {
        console.warn(
          "[admin-orders] recordOrderRefund failed:",
          String(e?.message || e),
        );
      });

      const refundAmountMinor = Math.round(refundAmount * 100);
      const refundIdStr = String(refund?.id || "");
      try {
        await Payment.create({
          transactionId:
            refundIdStr ||
            (
              idempotencyKey || `refund:admin:${order._id}:${paymentIntentId}`
            ).slice(0, 256),
          type: "refund",
          orderId: order._id,
          userId: order.userId || null,
          amountMinor: refundAmountMinor,
          currency: "ils",
          status: "succeeded",
          provider: "stripe",
          refundId: refundIdStr,
        });
      } catch (ledgerErr) {
        if (ledgerErr?.code !== 11000) {
          console.warn(
            "[admin-orders] payment ledger refund insert failed:",
            String(ledgerErr?.message || ledgerErr),
          );
        }
      }

      getRefundOperationsCounter().inc({ type: "stripe", status: "success" });

      sendRefundNotificationSafe(order._id, refundAmount).catch(() => {});

      return { order: updated, success: true };
    } catch (rfErr) {
      getRefundOperationsCounter().inc({ type: "stripe", status: "failure" });
      const updated = await Order.findByIdAndUpdate(
        order._id,
        {
          $set: {
            status: "refund_pending",
            "refund.status": "failed",
            "refund.failureMessage": String(
              rfErr?.message || "Refund failed",
            ).slice(0, 800),
            ...(note ? { internalNote: String(note) } : {}),
          },
        },
        { new: true },
      );

      return { order: updated, success: false, pendingManualAction: true };
    }
  } else {
    // COD orders - manual refund marking (no automatic financial execution)
    const isPartial =
      refundAmount > 0 && orderTotal > 0 && refundAmount < orderTotal;

    const updated = await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: isPartial ? "partially_refunded" : "refunded",
          "refund.status": "succeeded",
          "refund.amount": refundAmount,
          "refund.currency": "ils",
          "refund.reason": reason || "other",
          "refund.refundedAt": new Date(),
          "refund.manualTransferRequired": true,
          ...(note ? { internalNote: String(note) } : {}),
        },
      },
      { new: true },
    );

    /**
     * ✅ DELIVERABLE #4: Update ranking/stats after successful COD refund
     * Uses analytics.refundCountedAt marker for idempotency
     */
    await recordOrderRefund(updated, {
      refundAmountMinor: Math.round(refundAmount * 100),
      reason: reason || "other",
    }).catch((e) => {
      console.warn(
        "[admin-orders] recordOrderRefund (COD) failed:",
        String(e?.message || e),
      );
    });

    const codTransactionId = (
      idempotencyKey || `refund:cod:${order._id}:${Date.now()}`
    ).slice(0, 256);
    try {
      await Payment.create({
        transactionId: codTransactionId,
        type: "refund",
        orderId: order._id,
        userId: order.userId || null,
        amountMinor: Math.round(refundAmount * 100),
        currency: "ils",
        status: "succeeded",
        provider: "cod",
      });
    } catch (ledgerErr) {
      if (ledgerErr?.code !== 11000) {
        console.warn(
          "[admin-orders] payment ledger COD refund insert failed:",
          String(ledgerErr?.message || ledgerErr),
        );
      }
    }

    getRefundOperationsCounter().inc({ type: "cod", status: "success" });

    sendRefundNotificationSafe(order._id, refundAmount).catch(() => {});

    return { order: updated, success: true, manualRefund: true };
  }
}

/**
 * Update invoice fields + allocation info
 */
export async function updateOrderInvoice(orderId, invoiceData) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const existing = await Order.findById(orderId);
  if (!existing) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  const { number, url, customerCompanyName, customerVatId, allocationNumber } =
    invoiceData;
  const set = {};

  if (number) set["invoice.number"] = number;
  if (url) set["invoice.url"] = url;
  if (customerCompanyName)
    set["invoice.customerCompanyName"] = customerCompanyName;
  if (customerVatId) set["invoice.customerVatId"] = customerVatId;

  const orderForAlloc = existing.toObject();
  orderForAlloc.invoice = orderForAlloc.invoice || {};
  if (customerCompanyName)
    orderForAlloc.invoice.customerCompanyName = customerCompanyName;
  if (customerVatId) orderForAlloc.invoice.customerVatId = customerVatId;

  const allocation = computeAllocationRequirement({
    order: orderForAlloc,
    pricing: existing.pricing,
  });

  const now = new Date();

  if (allocationNumber) {
    set["invoice.allocation.required"] = true;
    set["invoice.allocation.status"] = "issued";
    set["invoice.allocation.number"] = allocationNumber;
    set["invoice.allocation.issuedAt"] = now;
    set["invoice.allocation.thresholdBeforeVat"] =
      allocation.thresholdBeforeVat;
    if (!existing.invoice?.allocation?.requestedAt) {
      set["invoice.allocation.requestedAt"] = now;
    }
  } else {
    set["invoice.allocation.required"] = allocation.required;
    set["invoice.allocation.status"] = allocation.status;
    set["invoice.allocation.thresholdBeforeVat"] =
      allocation.thresholdBeforeVat;
    if (allocation.required && !existing.invoice?.allocation?.requestedAt) {
      set["invoice.allocation.requestedAt"] = now;
    }
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: set },
    { new: true, runValidators: true },
  );

  if (!updated) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  return updated;
}

/**
 * Issue invoice manually
 */
export async function issueOrderInvoice(orderId) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  // Check if already issued
  if (order?.invoice?.status === "issued") {
    return { order, alreadyIssued: true };
  }

  const idempotencyKey = buildInvoiceIdempotencyKey(order);

  try {
    const invoice = await createInvoiceForOrder(order, { idempotencyKey });

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": invoice.provider,
          "invoice.docId": invoice.docId || "",
          "invoice.providerDocId": invoice.providerDocId || "",
          "invoice.idempotencyKey": idempotencyKey,
          "invoice.docType": invoice.docType || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": invoice.status || "pending",
          "invoice.error": invoice.error || "",
          "invoice.snapshot":
            invoice.raw && typeof invoice.raw === "object" ? invoice.raw : null,
          "invoice.allocation": invoice.allocation || {},
        },
      },
    );
    recordInvoiceIssueMetric("success", "initial");

    const updated = await Order.findById(order._id);
    return { order: updated, success: true };
  } catch (invoiceErr) {
    const provider = resolveInvoiceProvider(order);

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": provider,
          "invoice.docId": String(order._id),
          "invoice.idempotencyKey": idempotencyKey,
          "invoice.number": "",
          "invoice.url": "",
          "invoice.issuedAt": null,
          "invoice.status": "failed",
          "invoice.error": String(invoiceErr?.message || "Invoice failed"),
        },
      },
    );
    recordInvoiceIssueMetric("failure", "initial");

    const updated = await Order.findById(order._id);
    throw Object.assign(
      makeErr(
        500,
        "INVOICE_FAILED",
        String(invoiceErr?.message || "Failed to issue invoice"),
      ),
      { order: updated },
    );
  }
}
