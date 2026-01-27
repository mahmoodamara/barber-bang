// src/services/admin-orders.service.js
// Single source of truth for admin order operations.
// Used by both admin.routes.js (legacy) and admin.orders.routes.js.

import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { createStripeRefund } from "./stripe.service.js";
import { createInvoiceForOrder, resolveInvoiceProvider } from "./invoice.service.js";
import { computeAllocationRequirement } from "../utils/allocation.js";
import { mapOrder } from "../utils/mapOrder.js";
import { releaseCouponReservation } from "./pricing.service.js";
import { recordOrderSale, rankingConfig } from "./ranking.service.js";

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
  return mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
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
  paid: ["payment_received", "confirmed", "stock_confirmed", "shipped", "refund_pending", "cancelled"],
  payment_received: ["confirmed", "stock_confirmed", "shipped", "refund_pending", "cancelled"],
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

export async function issueInvoiceBestEffort(order) {
  if (!order || !order._id) return;
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
      `Cannot transition from "${currentStatus}" to "${nextStatus}"`
    );
  }

  const update = { status: nextStatus };

  // Auto-set timestamps
  if (!order.paidAt && (nextStatus === "paid" || nextStatus === "payment_received")) {
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
    { new: true, runValidators: true }
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
    { new: true, runValidators: true }
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
    throw makeErr(400, "CANNOT_CANCEL", `Order in status "${order.status}" cannot be cancelled`);
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
          String(restockErr?.message || restockErr)
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
    const code = String(order?.pricing?.discounts?.coupon?.code || order?.pricing?.couponCode || "").trim();
    if (code) {
      await releaseCouponReservation({ code, orderId: order._id }).catch((e) => {
        console.warn("[best-effort] admin cancel release coupon reservation failed:", String(e?.message || e));
      });
    }
    update["couponReservation.status"] = "released";
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: update },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  return { order: updated, restocked: Boolean(restock) };
}

/**
 * Process refund for an order (Stripe or COD)
 */
export async function processRefund(orderId, { amount, reason, note, idempotencyKey }) {
  if (!isValidObjectId(orderId)) {
    throw makeErr(400, "INVALID_ID", "Invalid Order id");
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw makeErr(404, "NOT_FOUND", "Order not found");
  }

  // Check if already fully refunded
  if (order.status === "refunded" || order?.refund?.status === "succeeded") {
    return { order, alreadyRefunded: true };
  }

  const orderTotal = Number(order?.pricing?.total ?? order?.total ?? 0);
  const refundAmount = typeof amount === "number" ? amount : orderTotal;

  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    throw makeErr(400, "INVALID_REFUND_AMOUNT", "Refund amount must be > 0");
  }
  if (orderTotal > 0 && refundAmount > orderTotal) {
    throw makeErr(400, "AMOUNT_EXCEEDS_TOTAL", "Refund amount exceeds order total");
  }

  // Handle Stripe refunds
  if (order.paymentMethod === "stripe") {
    const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
    if (!paymentIntentId) {
      throw makeErr(400, "MISSING_PAYMENT_INTENT", "Order has no paymentIntentId");
    }

    // Idempotency guard
    if (idempotencyKey && String(order?.idempotency?.refundKey || "") === idempotencyKey) {
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
          ...(idempotencyKey ? { "idempotency.refundKey": idempotencyKey } : {}),
          ...(note ? { internalNote: String(note) } : {}),
        },
      }
    );

    try {
      const refund = await createStripeRefund({
        paymentIntentId,
        amountMajor: refundAmount,
        reason: reason || "other",
        idempotencyKey: idempotencyKey || `refund:admin:${String(order._id)}:${paymentIntentId}:${refundAmount}`,
      });

      const isPartial = refundAmount > 0 && orderTotal > 0 && refundAmount < orderTotal;

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
        { new: true }
      );

      return { order: updated, success: true };
    } catch (rfErr) {
      const updated = await Order.findByIdAndUpdate(
        order._id,
        {
          $set: {
            status: "refund_pending",
            "refund.status": "failed",
            "refund.failureMessage": String(rfErr?.message || "Refund failed").slice(0, 800),
            ...(note ? { internalNote: String(note) } : {}),
          },
        },
        { new: true }
      );

      return { order: updated, success: false, pendingManualAction: true };
    }
  } else {
    // COD orders - manual refund marking
    const isPartial = refundAmount > 0 && orderTotal > 0 && refundAmount < orderTotal;

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
          ...(note ? { internalNote: String(note) } : {}),
        },
      },
      { new: true }
    );

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

  const { number, url, customerCompanyName, customerVatId, allocationNumber } = invoiceData;
  const set = {};

  if (number) set["invoice.number"] = number;
  if (url) set["invoice.url"] = url;
  if (customerCompanyName) set["invoice.customerCompanyName"] = customerCompanyName;
  if (customerVatId) set["invoice.customerVatId"] = customerVatId;

  const orderForAlloc = existing.toObject();
  orderForAlloc.invoice = orderForAlloc.invoice || {};
  if (customerCompanyName) orderForAlloc.invoice.customerCompanyName = customerCompanyName;
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
    set["invoice.allocation.thresholdBeforeVat"] = allocation.thresholdBeforeVat;
    if (!existing.invoice?.allocation?.requestedAt) {
      set["invoice.allocation.requestedAt"] = now;
    }
  } else {
    set["invoice.allocation.required"] = allocation.required;
    set["invoice.allocation.status"] = allocation.status;
    set["invoice.allocation.thresholdBeforeVat"] = allocation.thresholdBeforeVat;
    if (allocation.required && !existing.invoice?.allocation?.requestedAt) {
      set["invoice.allocation.requestedAt"] = now;
    }
  }

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: set },
    { new: true, runValidators: true }
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
      }
    );

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
          "invoice.number": "",
          "invoice.url": "",
          "invoice.issuedAt": null,
          "invoice.status": "failed",
          "invoice.error": String(invoiceErr?.message || "Invoice failed"),
        },
      }
    );

    const updated = await Order.findById(order._id);
    throw Object.assign(
      makeErr(500, "INVOICE_FAILED", String(invoiceErr?.message || "Failed to issue invoice")),
      { order: updated }
    );
  }
}
