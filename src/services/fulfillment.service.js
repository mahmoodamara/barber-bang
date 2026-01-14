import { Order } from "../models/Order.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function str(v) {
  return v === null || v === undefined ? "" : String(v);
}

function trimMax(v, max) {
  return str(v).trim().slice(0, max);
}

function normalizeEventType(v) {
  return trimMax(v, 40).toLowerCase().replace(/\s+/g, "_");
}

export async function getMyOrderFulfillment({ orderId, userId } = {}) {
  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");
  const order = await applyQueryBudget(
    Order.findOne({ _id: orderId, userId })
      .select("status fulfillment tracking trackingHistory updatedAt createdAt")
      .lean(),
  );
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
  return {
    orderId: String(order._id),
    status: order.status,
    fulfillment: order.fulfillment || { events: [] },
    tracking: order.tracking || null,
    trackingHistory: Array.isArray(order.trackingHistory) ? order.trackingHistory : [],
    updatedAt: order.updatedAt || null,
    createdAt: order.createdAt || null,
  };
}

export async function adminAddOrderFulfillmentEvent(
  orderId,
  { type, at, note, meta } = {},
  ctx = null,
) {
  const eventType = normalizeEventType(type);
  if (!eventType) throw httpError(400, "FULFILLMENT_TYPE_REQUIRED", "type is required");

  return await withRequiredTransaction(async (session) => {
    const order = await applyQueryBudget(Order.findById(orderId).session(session));
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    order.fulfillment = order.fulfillment || { events: [] };
    order.fulfillment.events = Array.isArray(order.fulfillment.events) ? order.fulfillment.events : [];

    order.fulfillment.events.push({
      type: eventType,
      at: at ? new Date(at) : new Date(),
      note: note !== undefined ? trimMax(note, 500) : "",
      meta: meta ?? null,
    });

    // Keep events bounded to prevent unbounded growth (append-only)
    if (order.fulfillment.events.length > 200) {
      order.fulfillment.events = order.fulfillment.events.slice(order.fulfillment.events.length - 200);
    }

    // Append statusHistory v2-compatible note (non-breaking observability)
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({
      status: String(order.status || "unknown"),
      at: new Date(),
      note: `fulfillment:${eventType}`,
      meta: { fulfillment: { type: eventType }, requestId: ctx?.requestId || null },
    });

    await order.save({ session });
    const updated = await applyQueryBudget(
      Order.findById(order._id)
        .select("status fulfillment tracking trackingHistory updatedAt createdAt")
        .session(session)
        .lean(),
    );
    return {
      orderId: String(order._id),
      status: updated?.status || order.status,
      fulfillment: updated?.fulfillment || order.fulfillment,
      tracking: updated?.tracking || null,
      trackingHistory: Array.isArray(updated?.trackingHistory) ? updated.trackingHistory : [],
      updatedAt: updated?.updatedAt || null,
      createdAt: updated?.createdAt || null,
    };
  });
}

