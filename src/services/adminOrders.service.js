import mongoose from "mongoose";
import Stripe from "stripe";

import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { ENV } from "../utils/env.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import {
  buildListEnvelope,
  buildSearchOrFilter,
  parseAdminPagination,
  parseSort,
} from "../utils/adminQuery.js";
import { formatOrderForResponse } from "../utils/orderResponse.js";
import { assertOrderTransition, ORDER_STATUS, ORDER_SYSTEM_MANAGED_STATUSES } from "../utils/orderState.js";

import { releaseReservedStockBulk } from "./stock.service.js";
import { removeCouponFromOrder } from "./coupon.service.js";
import { releasePromotionsForOrder } from "./promotion.service.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { confirmPaidOrderStock } from "./payment.service.js";

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY);

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function asObjectIdOrNull(v) {
  const s = String(v || "");
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function safeStr(v, max = 300) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function safeCode(v, max = 80) {
  const s = String(v ?? "").trim();
  return s.length ? (s.length > max ? s.slice(0, max) : s) : null;
}

function normRoles(roles) {
  return Array.isArray(roles) ? roles.map((r) => String(r)).filter(Boolean).slice(0, 10) : [];
}

function actorKindFromRoles(roles) {
  const rs = new Set(normRoles(roles));
  if (rs.has("admin")) return "admin";
  if (rs.has("staff")) return "staff";
  return "user";
}

async function resolveActorEmail(actorId) {
  const id = asObjectIdOrNull(actorId);
  if (!id) return null;
  const u = await User.findById(id).select("email").lean();
  return u?.email ? String(u.email) : null;
}

async function buildActorSnapshot(ctx) {
  const id = asObjectIdOrNull(ctx?.actorId);
  const roles = normRoles(ctx?.roles);
  const kind = id ? actorKindFromRoles(roles) : "system";
  const email = (ctx?.email ? String(ctx.email) : null) ?? (id ? await resolveActorEmail(id) : null);
  return {
    kind,
    id,
    roles,
    email,
  };
}

function buildRequestSnapshot(ctx) {
  return {
    requestId: ctx?.requestId ? String(ctx.requestId).slice(0, 120) : null,
    ip: ctx?.ip ? String(ctx.ip).slice(0, 80) : null,
    userAgent: ctx?.userAgent ? String(ctx.userAgent).slice(0, 300) : null,
  };
}

function refundRulesSummary(order, ctx) {
  const isAdmin = new Set(normRoles(ctx?.roles)).has("admin");
  if (!isAdmin) return false;

  const allowedStatuses = new Set([
    "paid",
    "stock_confirmed",
    "fulfilled",
    "partially_refunded",
    "payment_received",
  ]);
  if (!allowedStatuses.has(String(order?.status || ""))) return false;

  const paidAt = order?.payment?.paidAt ? new Date(order.payment.paidAt).getTime() : null;
  const maxDays = Number(ENV.REFUND_MAX_DAYS || 14);
  if (paidAt && Number.isFinite(maxDays)) {
    const deadline = paidAt + Number(maxDays) * 24 * 60 * 60_000;
    if (Date.now() > deadline) return false;
  }

  const paidTotal = Number(order?.pricing?.grandTotal || 0);
  const alreadyRefunded = Number(order?.refund?.amountRefunded || 0);
  if (!Number.isInteger(paidTotal) || paidTotal < 0) return false;
  if (!Number.isInteger(alreadyRefunded) || alreadyRefunded < 0) return false;
  const refundable = Math.max(0, paidTotal - alreadyRefunded);
  if (refundable <= 0) return false;

  const pi = order?.payment?.stripePaymentIntentId;
  if (!pi) return false;

  return true;
}

function computeAdminOrderActions(order, ctx) {
  const status = String(order?.status || "");
  const stockStatus = String(order?.stock?.status || "");
  return {
    canCancel: status === ORDER_STATUS.DRAFT || status === ORDER_STATUS.PENDING_PAYMENT,
    canFulfill: status === ORDER_STATUS.STOCK_CONFIRMED && stockStatus === "confirmed",
    canUpdateTracking: ![ORDER_STATUS.DRAFT, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.CANCELLED].includes(status),
    canAddNote: true,
    canRefund: refundRulesSummary(order, ctx),
  };
}

function toAdminOrderDTO(docOrLean, { compact = false, ctx = null } = {}) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;

  const base = compact
    ? formatOrderForResponse({ ...d, items: undefined, billingAddress: undefined, statusHistory: undefined, adminNotes: undefined })
    : formatOrderForResponse(d);

  const tracking = d.tracking
    ? {
        carrier: d.tracking.carrier || null,
        trackingNumber: d.tracking.trackingNumber || null,
        trackingUrl: d.tracking.trackingUrl || null,
        updatedAt: d.tracking.updatedAt || null,
        updatedBy: d.tracking.updatedBy ? String(d.tracking.updatedBy) : null,
      }
    : null;

  const adminNotes = Array.isArray(d.adminNotes)
    ? d.adminNotes.map((n) => ({
        at: n.at,
        actorId: n.actorId ? String(n.actorId) : null,
        roles: Array.isArray(n.roles) ? n.roles : [],
        note: n.note,
      }))
    : [];

  const out = {
    ...base,
    tracking,
    statusChangedAt: d.statusChangedAt || null,
    statusChangedBy: d.statusChangedBy || null,
    actions: computeAdminOrderActions(d, ctx),
  };

  if (!compact) {
    out.trackingHistory = Array.isArray(d.trackingHistory) ? d.trackingHistory : [];
    out.adminNotes = adminNotes;
  }

  return out;
}

function buildCreatedAtRangeFilter({ fromDate, toDate } = {}) {
  if (!fromDate && !toDate) return null;
  const out = {};
  if (fromDate) out.$gte = new Date(fromDate);
  if (toDate) out.$lte = new Date(toDate);
  return { createdAt: out };
}

export async function adminListOrders({ q, ctx } = {}) {
  const { page, limit, skip } = parseAdminPagination(q, { defaultLimit: 20, maxLimit: 100 });

  const filter = {};
  if (q.status) filter.status = String(q.status);

  const createdAt = buildCreatedAtRangeFilter({ fromDate: q.fromDate, toDate: q.toDate });
  if (createdAt) Object.assign(filter, createdAt);

  const search = buildSearchOrFilter(q.q, [
    "orderNumber",
    "guestEmail",
    "shippingAddress.phone",
    "shippingAddress.fullName",
  ]);
  if (search) Object.assign(filter, search);

  const sort = parseSort(q.sort, ["createdAt", "status", "total", "orderNumber"], {
    fieldMap: {
      total: "pricing.grandTotal",
    },
    defaultSort: { createdAt: -1, _id: -1 },
  });

  const fields =
    "orderNumber userId guestEmail lang status pricing coupon promotionCode promotions shippingAddress shippingMethod stock " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund tracking statusChangedAt statusChangedBy createdAt updatedAt";

  const [items, total] = await Promise.all([
    applyQueryBudget(Order.find(filter).select(fields).sort(sort).skip(skip).limit(limit).lean()),
    applyQueryBudget(Order.countDocuments(filter)),
  ]);

  return buildListEnvelope({
    items: items.map((x) => toAdminOrderDTO(x, { compact: true, ctx })),
    page,
    limit,
    total,
  });
}

export async function adminGetOrder(orderId, { ctx } = {}) {
  const fields =
    "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory tracking trackingHistory adminNotes stock statusChangedAt statusChangedBy createdAt updatedAt";

  const order = await applyQueryBudget(
    Order.findById(orderId).select(fields).lean(),
  );
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return toAdminOrderDTO(order, { compact: false, ctx });
}

export async function transitionOrderStatusAtomic({
  orderId,
  from,
  to,
  actor,
  reason,
  code,
  meta,
  ctx,
  session,
} = {}) {
  const fromStatus = String(from || "");
  const toStatus = String(to || "");
  const now = new Date();

  const actorSnapshot = actor || (await buildActorSnapshot(ctx));
  const request = buildRequestSnapshot(ctx);

  const event = {
    from: fromStatus,
    to: toStatus,
    status: toStatus, // backward compatibility
    at: now,
    actor: actorSnapshot,
    reason: safeStr(reason, 300),
    code: safeCode(code, 80),
    request,
    meta: meta ?? null,
    note: "",
  };

  const set = {
    status: toStatus,
    statusChangedAt: now,
    statusChangedBy: actorSnapshot,
  };

  if (toStatus === ORDER_STATUS.CANCELLED) {
    set["cancel.canceledAt"] = now;
    set["cancel.canceledBy"] = "admin";
    set["cancel.reason"] = safeStr(reason, 300);
  }

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: fromStatus },
    { $set: set, $push: { statusHistory: event } },
    { new: true, session, runValidators: true, context: "query" },
  ).lean();

  if (!updated) {
    throw httpError(409, "ORDER_STATUS_CONFLICT", "Order status conflict", {
      expectedFrom: fromStatus,
    });
  }

  return updated;
}

async function cancelOrderAdmin({ orderId, reason, ctx } = {}) {
  const actor = await buildActorSnapshot(ctx);
  const updated = await withRequiredTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    // Idempotent: if already cancelled, return current state (cleanup leaked reserve if any)
    if (order.status === ORDER_STATUS.CANCELLED) {
      if (order.stock?.status === "reserved" || !order.stock) {
        const now = new Date();
        await releaseReservedStockBulk(order._id, order.items || [], {
          session,
          requireActive: false,
          reason: "admin_cancel",
          allowLegacy: true,
        });
        await Order.findByIdAndUpdate(
          order._id,
          { $set: { "stock.status": "released", "stock.releasedAt": now, "stock.lastError": null } },
          { session, runValidators: true, context: "query" },
        );
      }
      if (Array.isArray(order.promotions) && order.promotions.length) {
        try {
          await releasePromotionsForOrder({ orderId: order._id, session });
        } catch {
          // best-effort
        }
      }
      return order.toObject();
    }

    // Minimal safe policy:
    // - Admin cancel is allowed only for draft/pending_payment
    if (![ORDER_STATUS.DRAFT, ORDER_STATUS.PENDING_PAYMENT].includes(order.status)) {
      throw httpError(409, "ORDER_CANCEL_NOT_ALLOWED", "Order cannot be cancelled at this stage", {
        status: order.status,
      });
    }

    const now = new Date();

    if (order.stock?.status === "reserved" || !order.stock) {
      await releaseReservedStockBulk(order._id, order.items || [], {
        session,
        requireActive: false,
        reason: "admin_cancel",
        allowLegacy: true,
      });
      await Order.findByIdAndUpdate(
        order._id,
        { $set: { "stock.status": "released", "stock.releasedAt": now, "stock.lastError": null } },
        { session, runValidators: true, context: "query" },
      );
    }

    assertOrderTransition(order.status, ORDER_STATUS.CANCELLED);

    if (order.coupon?.code) {
      try {
        await removeCouponFromOrder({
          orderId: order._id,
          auth: { role: "system" },
          _internal: true,
          options: { session },
        });
      } catch {
        // best-effort
      }
    }
    if (Array.isArray(order.promotions) && order.promotions.length) {
      try {
        await releasePromotionsForOrder({ orderId: order._id, session });
      } catch {
        // best-effort
      }
    }

    const updatedOrder = await transitionOrderStatusAtomic({
      orderId: order._id,
      from: order.status,
      to: ORDER_STATUS.CANCELLED,
      actor,
      reason,
      code: "admin_cancel",
      meta: { stockStatus: order.stock?.status || null },
      ctx,
      session,
    });

    return updatedOrder;
  });

  // Best-effort: expire stripe session
  const sid = updated?.payment?.stripeSessionId;
  if (sid) {
    try {
      await stripe.checkout.sessions.expire(sid);
    } catch {
      // ignore
    }
  }

  return updated;
}

async function fulfillOrderAdmin({ orderId, note, ctx } = {}) {
  const actor = await buildActorSnapshot(ctx);
  const updated = await withRequiredTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    // Minimal safe policy:
    // - Only allow stock_confirmed -> fulfilled
    if (order.status !== ORDER_STATUS.STOCK_CONFIRMED) {
      throw httpError(409, "ORDER_FULFILL_NOT_ALLOWED", "Order cannot be fulfilled at this stage", {
        status: order.status,
      });
    }

    if (order.stock?.status !== "confirmed") {
      throw httpError(409, "ORDER_STOCK_NOT_CONFIRMED", "Order stock is not confirmed", {
        stockStatus: order.stock?.status || null,
      });
    }

    assertOrderTransition(order.status, ORDER_STATUS.FULFILLED);

    const updatedOrder = await transitionOrderStatusAtomic({
      orderId: order._id,
      from: order.status,
      to: ORDER_STATUS.FULFILLED,
      actor,
      reason: note,
      code: "admin_fulfill",
      meta: { stockStatus: order.stock?.status || null },
      ctx,
      session,
    });

    return updatedOrder;
  });

  return updated;
}

export async function adminUpdateOrderStatus(
  orderId,
  { status, reason } = {},
  ctx = null,
) {
  const to = String(status || "");

  // Refunding should go through refund flow to ensure idempotency + payment provider safety.
  if (to === ORDER_STATUS.REFUNDED || to === ORDER_STATUS.PARTIALLY_REFUNDED) {
    throw httpError(409, "USE_REFUND_ENDPOINT", "Use the refund endpoint for refunds");
  }

  // Payment pipeline statuses should remain system-managed.
  if (ORDER_SYSTEM_MANAGED_STATUSES.includes(to)) {
    throw httpError(409, "ORDER_STATUS_SYSTEM_MANAGED", "This status is system-managed");
  }

  if (to === ORDER_STATUS.CANCELLED) {
    const updated = await cancelOrderAdmin({ orderId, reason, ctx });
    return toAdminOrderDTO(updated, { compact: false, ctx });
  }

  if (to === ORDER_STATUS.FULFILLED) {
    const updated = await fulfillOrderAdmin({ orderId, note: reason, ctx });
    return toAdminOrderDTO(updated, { compact: false, ctx });
  }

  throw httpError(409, "ORDER_STATUS_UPDATE_NOT_ALLOWED", "This status update is not allowed", {
    to,
  });
}

export async function adminUpdateOrderTracking(
  orderId,
  { carrier, trackingNumber, trackingUrl } = {},
  ctx = {},
) {
  const order = await applyQueryBudget(Order.findById(orderId).select("status tracking").lean());
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  if ([ORDER_STATUS.DRAFT, ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.CANCELLED].includes(order.status)) {
    throw httpError(409, "TRACKING_NOT_ALLOWED", "Tracking update not allowed in current status", {
      status: order.status,
    });
  }

  const now = new Date();
  const actor = await buildActorSnapshot(ctx);
  const request = buildRequestSnapshot(ctx);

  const set = {
    "tracking.updatedAt": now,
    "tracking.updatedBy": asObjectIdOrNull(ctx?.actorId),
  };

  const prev = order.tracking || {};
  const nextCarrier = carrier !== undefined ? (String(carrier || "").trim() || null) : (prev.carrier ?? null);
  const nextTrackingNumber = trackingNumber !== undefined ? (String(trackingNumber || "").trim() || null) : (prev.trackingNumber ?? null);
  const nextTrackingUrl = trackingUrl !== undefined ? (String(trackingUrl || "").trim() || null) : (prev.trackingUrl ?? null);

  if (carrier !== undefined) set["tracking.carrier"] = nextCarrier;
  if (trackingNumber !== undefined) set["tracking.trackingNumber"] = nextTrackingNumber;
  if (trackingUrl !== undefined) set["tracking.trackingUrl"] = nextTrackingUrl;

  const trackingEvent = { at: now, actor, carrier: nextCarrier, trackingNumber: nextTrackingNumber, trackingUrl: nextTrackingUrl, request };

  const fields =
    "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory tracking trackingHistory adminNotes stock statusChangedAt statusChangedBy createdAt updatedAt";

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $set: set, $push: { trackingHistory: trackingEvent } },
    { new: true, runValidators: true, context: "query", select: fields },
  ).lean();

  if (!updated) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return toAdminOrderDTO(updated, { compact: false, ctx });
}

export async function adminAddOrderNote(orderId, { note } = {}, ctx = {}) {
  const now = new Date();
  const trimmed = String(note || "").trim();
  if (trimmed.length < 2 || trimmed.length > 1000) {
    throw httpError(400, "INVALID_NOTE", "Note length must be between 2 and 1000 characters", {
      length: trimmed.length,
    });
  }

  const doc = {
    at: now,
    actorId: asObjectIdOrNull(ctx?.actorId),
    roles: normRoles(ctx?.roles),
    note: trimmed,
  };

  const fields =
    "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory tracking trackingHistory adminNotes stock statusChangedAt statusChangedBy createdAt updatedAt";

  const updated = await Order.findByIdAndUpdate(
    orderId,
    { $push: { adminNotes: doc } },
    { new: true, runValidators: true, context: "query", select: fields },
  ).lean();

  if (!updated) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return toAdminOrderDTO(updated, { compact: false, ctx });
}

export async function adminResolvePayment(
  orderId,
  { action, note } = {},
  ctx = {},
) {
  const op = String(action || "");
  if (!["retry_stock_confirm", "mark_requires_refund"].includes(op)) {
    throw httpError(400, "INVALID_ACTION", "Invalid action");
  }

  const trimmed = safeStr(note, 500);
  const now = new Date();

  const updated = await withRequiredTransaction(async (session) => {
    const order = await applyQueryBudget(
      Order.findById(orderId).session(session),
    );
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    if (op === "retry_stock_confirm") {
      const ok = await confirmPaidOrderStock(order._id, { session });
      if (!ok) {
        throw httpError(409, "ORDER_NOT_ELIGIBLE", "Order is not eligible for stock confirm retry", {
          status: order.status,
          stockStatus: order.stock?.status || null,
        });
      }
    }

    if (op === "mark_requires_refund") {
      order.payment = order.payment || {};

      // Idempotent: if already marked, just return
      if (order.payment.status !== "requires_refund") {
        if (order.status !== "payment_received") {
          throw httpError(409, "ORDER_NOT_ELIGIBLE", "Order must be payment_received to mark requires_refund", {
            status: order.status,
          });
        }
        order.payment.status = "requires_refund";
        order.payment.lastError = order.payment.lastError || "ADMIN_MARKED_REQUIRES_REFUND";
      }
    }

    // Append an admin note for traceability (append-only)
    order.adminNotes = Array.isArray(order.adminNotes) ? order.adminNotes : [];
    order.adminNotes.push({
      at: now,
      actorId: asObjectIdOrNull(ctx?.actorId),
      roles: normRoles(ctx?.roles),
      note: trimmed ? `[payment:${op}] ${trimmed}` : `[payment:${op}]`,
    });

    await order.save({ session });

    const fields =
      "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
      "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory tracking trackingHistory adminNotes stock statusChangedAt statusChangedBy createdAt updatedAt";

    const fresh = await Order.findById(order._id)
      .select(fields)
      .session(session)
      .lean();
    if (!fresh) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    return toAdminOrderDTO(fresh, { compact: false, ctx });
  });

  return updated;
}
