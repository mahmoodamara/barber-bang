import mongoose from "mongoose";
import { NotificationLog } from "../models/NotificationLog.js";
import { Order } from "../models/Order.js";
import { ReturnRequest } from "../models/ReturnRequest.js";
import { User } from "../models/User.js";
import { enqueueJob } from "../jobs/jobRunner.js";

const { Types } = mongoose;

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function safeStr(v, max) {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

async function resolveOrderRecipientEmail(order) {
  if (!order) return null;
  if (order.guestEmail) return String(order.guestEmail).trim();
  if (!order.userId) return null;
  const user = await User.findById(order.userId).select("emailLower email").lean();
  return (user?.emailLower || user?.email || null) ? String(user.emailLower || user.email).trim() : null;
}

function buildOrderNotification({ orderId, orderNumber, event }) {
  const o = orderNumber ? `Order ${orderNumber}` : `Order ${String(orderId).slice(-6)}`;

  if (event === "order_placed") {
    return { subject: `${o} placed`, text: `We received your order.`, html: `<p>We received your order.</p>` };
  }
  if (event === "order_paid") {
    return { subject: `${o} paid`, text: `Payment received.`, html: `<p>Payment received.</p>` };
  }
  if (event === "order_shipped") {
    return { subject: `${o} shipped`, text: `Your order has shipped.`, html: `<p>Your order has shipped.</p>` };
  }
  if (event === "order_delivered") {
    return { subject: `${o} delivered`, text: `Your order was delivered.`, html: `<p>Your order was delivered.</p>` };
  }
  if (event === "order_refunded") {
    return { subject: `${o} refunded`, text: `Your refund was processed.`, html: `<p>Your refund was processed.</p>` };
  }
  return { subject: `${o} update`, text: `Your order has an update.`, html: `<p>Your order has an update.</p>` };
}

function buildReturnNotification({ event, returnId, orderNumber }) {
  const r = orderNumber ? `Return for order ${orderNumber}` : `Return ${String(returnId).slice(-6)}`;
  return {
    subject: `${r} updated`,
    text: `Your return request was updated (${event}).`,
    html: `<p>Your return request was updated (${safeStr(event, 80)}).</p>`,
  };
}

async function createNotificationLog({
  event,
  channel = "email",
  to,
  subject,
  text,
  html,
  orderId = null,
  returnId = null,
  dedupeKey = null,
  meta = null,
} = {}) {
  if (!event) throw httpError(400, "NOTIFICATION_EVENT_REQUIRED", "event is required");

  try {
    const created = await NotificationLog.create({
      event,
      channel,
      to: to ? safeStr(to, 254) : null,
      subject: safeStr(subject, 200),
      text: safeStr(text, 20_000),
      html: safeStr(html, 50_000),
      orderId: orderId && Types.ObjectId.isValid(String(orderId)) ? new Types.ObjectId(String(orderId)) : null,
      returnId: returnId && Types.ObjectId.isValid(String(returnId)) ? new Types.ObjectId(String(returnId)) : null,
      dedupeKey: dedupeKey ? safeStr(dedupeKey, 200) : null,
      meta,
    });
    return created;
  } catch (e) {
    // Duplicate dedupeKey => treat as already enqueued
    if (e?.code === 11000 && dedupeKey) return null;
    throw e;
  }
}

async function enqueueSendJob(notificationId) {
  await enqueueJob({
    name: "notification_send",
    payload: { notificationId: String(notificationId) },
    dedupeKey: `notify_send:${String(notificationId)}`,
    runAt: new Date(),
    maxAttempts: 8,
  });
}

export async function enqueueOrderNotification({ orderId, event, dedupeKey = null, meta = null } = {}) {
  const order = await Order.findById(orderId).select("orderNumber userId guestEmail").lean();
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  const to = await resolveOrderRecipientEmail(order);
  if (!to) return { ok: true, skipped: true, reason: "NO_RECIPIENT" };

  const content = buildOrderNotification({ orderId: order._id, orderNumber: order.orderNumber, event });
  const log = await createNotificationLog({
    event,
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    orderId: order._id,
    dedupeKey,
    meta,
  });

  if (!log) return { ok: true, idempotent: true };
  await enqueueSendJob(log._id);
  return { ok: true, notificationId: String(log._id) };
}

export async function enqueueReturnNotification({ returnId, event, dedupeKey = null, meta = null } = {}) {
  const rr = await ReturnRequest.findById(returnId).select("orderId userId").lean();
  if (!rr) throw httpError(404, "RETURN_NOT_FOUND", "Return not found");

  const order = rr.orderId
    ? await Order.findById(rr.orderId).select("orderNumber userId guestEmail").lean()
    : null;

  const to =
    (order && (await resolveOrderRecipientEmail(order))) ||
    (rr.userId
      ? await (async () => {
          const user = await User.findById(rr.userId).select("emailLower email").lean();
          return (user?.emailLower || user?.email || null) ? String(user.emailLower || user.email).trim() : null;
        })()
      : null);

  if (!to) return { ok: true, skipped: true, reason: "NO_RECIPIENT" };

  const content = buildReturnNotification({ event, returnId: rr._id, orderNumber: order?.orderNumber });
  const log = await createNotificationLog({
    event: "return_updated",
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    orderId: rr.orderId || null,
    returnId: rr._id,
    dedupeKey,
    meta: { ...(meta || null), returnEvent: safeStr(event, 80) },
  });

  if (!log) return { ok: true, idempotent: true };
  await enqueueSendJob(log._id);
  return { ok: true, notificationId: String(log._id) };
}

