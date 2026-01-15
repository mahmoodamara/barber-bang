import Stripe from "stripe";
import { ENV } from "../utils/env.js";
import { Order } from "../models/Order.js";
import { confirmStock, releaseReservedStockBulk } from "./stock.service.js";
import { enqueueJob } from "../jobs/jobRunner.js";
import { ensureMinorUnitsInt, normalizeCurrency } from "../utils/stripe.js";
import { sendAlertOnce } from "./alert.service.js";
import { confirmCouponForPaidOrder, removeCouponFromOrder } from "./coupon.service.js";
import { confirmPromotionsForOrder, releasePromotionsForOrder } from "./promotion.service.js";
import { assertOrderTransition, ORDER_STATUS } from "../utils/orderState.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { repriceOrder } from "./reprice.service.js";
import { enqueueOrderNotification } from "./notification.service.js";

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY);

function computeOrderAmounts(order) {
  let subtotal = 0;
  for (const it of order.items || []) {
    ensureMinorUnitsInt(it.unitPrice);
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      const err = new Error("INVALID_QUANTITY");
      err.statusCode = 400;
      throw err;
    }
    subtotal += Number(it.unitPrice) * Number(it.quantity);
  }
  ensureMinorUnitsInt(subtotal);

  const discount = Number(order.pricing?.discountTotal ?? 0);
  const shipping = Number(order.pricing?.shipping ?? 0);
  const tax = Number(order.pricing?.taxMinor ?? order.pricing?.tax ?? 0);
  const grandTotal = Number(order.pricing?.grandTotal ?? 0);

  ensureMinorUnitsInt(discount);
  ensureMinorUnitsInt(shipping);
  ensureMinorUnitsInt(tax);
  ensureMinorUnitsInt(grandTotal);

  if (discount > subtotal && subtotal > 0) {
    const err = new Error("DISCOUNT_EXCEEDS_SUBTOTAL");
    err.statusCode = 409;
    throw err;
  }

  const computedGrand = Math.max(0, subtotal - discount + shipping + tax);
  if (computedGrand !== grandTotal) {
    const err = new Error("ORDER_PRICING_MISMATCH");
    err.statusCode = 409;
    throw err;
  }

  return { subtotal, discount, shipping, tax, grandTotal };
}

function orderCurrency(order) {
  return (
    normalizeCurrency(order.pricing?.currency) ||
    normalizeCurrency(ENV.STRIPE_CURRENCY) ||
    "ILS"
  );
}

/**
 * Phase 4 notes:
 * - Order statuses: pending_payment -> payment_received -> stock_confirmed -> fulfilled/refunded/cancelled
 * - payment.stripePaymentIntentId is required for refunds
 * - cancel fields: cancel.canceledAt / cancel.canceledBy / cancel.reason
 * - avoid storing floats: all amounts are minor unit integers
 * - idempotency for checkout + webhook processing
 */

export async function startCheckout({ orderId, userId }) {
  let order = await applyQueryBudget(Order.findOne({ _id: orderId, userId }));
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  if (order.status !== "pending_payment") {
    const err = new Error("ORDER_NOT_PAYABLE");
    err.statusCode = 409;
    throw err;
  }

  const stockStatus = order.stock?.status;
  if (stockStatus && stockStatus !== "reserved") {
    const err = new Error("STOCK_NOT_RESERVED");
    err.statusCode = 409;
    throw err;
  }

  // Optional: reject if already expired
  if (order.expiresAt && new Date(order.expiresAt).getTime() <= Date.now()) {
    const err = new Error("ORDER_EXPIRED");
    err.statusCode = 409;
    throw err;
  }

  // Safety net: recompute pricing snapshots before talking to Stripe.
  await repriceOrder(order._id);
  order = await applyQueryBudget(Order.findOne({ _id: orderId, userId }));
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const currency = orderCurrency(order);
  const stripeCurrency = currency.toLowerCase();
  const { subtotal, discount, shipping, tax, grandTotal } = computeOrderAmounts(order);

  // Reuse existing session only if totals still match
  if (order.payment?.stripeSessionUrl && order.payment?.stripeSessionId) {
    const sameAmount = order.payment.checkoutAmount === grandTotal;
    const sameCurrency =
      normalizeCurrency(order.payment.checkoutCurrency || currency) === currency;
    if (sameAmount && sameCurrency) return order.payment.stripeSessionUrl;

    try {
      await stripe.checkout.sessions.expire(order.payment.stripeSessionId);
    } catch {
      // best-effort
    }
  }

  let discounts = undefined;
  if (discount > 0) {
    const coupon = await stripe.coupons.create(
      {
        amount_off: discount,
        currency: stripeCurrency,
        duration: "once",
        name: `Order ${order.id} discount`,
      },
      { idempotencyKey: `order-discount:${order.id}:${discount}` },
    );
    discounts = [{ coupon: coupon.id }];
  }

  const lineItems = (order.items || []).map((i) => ({
    price_data: {
      currency: stripeCurrency,
      product_data: { name: i.skuSnapshot || "Item" },
      unit_amount: (() => {
        const raw = Number(i.unitPrice ?? 0);
        ensureMinorUnitsInt(raw);
        return raw;
      })(),
    },
    quantity: i.quantity,
  }));

  if (shipping > 0) {
    ensureMinorUnitsInt(shipping);
    lineItems.push({
      price_data: {
        currency: stripeCurrency,
        product_data: { name: "Shipping" },
        unit_amount: shipping,
      },
      quantity: 1,
    });
  }

  if (tax > 0) {
    ensureMinorUnitsInt(tax);
    lineItems.push({
      price_data: {
        currency: stripeCurrency,
        product_data: { name: "Tax" },
        unit_amount: tax,
      },
      quantity: 1,
    });
  }

  const payableTotal = Math.max(0, subtotal - discount + shipping + tax);
  if (payableTotal <= 0) {
    await finalizeFreeOrder(order, currency);
    return `${ENV.FRONTEND_URL}/success?order=${order.id}`;
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      currency: stripeCurrency,
      line_items: lineItems,
      ...(discounts ? { discounts } : {}),
      success_url: `${ENV.FRONTEND_URL}/success?order=${order.id}`,
      cancel_url: `${ENV.FRONTEND_URL}/cancel?order=${order.id}`,
      metadata: { orderId: order.id },
      client_reference_id: order.id,
    },
    { idempotencyKey: `checkout:${order.id}` },
  );

  // Persist session identifiers for later reconcile / cancel / ops
  order.payment = {
    ...(order.payment || {}),
    provider: "stripe",
    stripeSessionId: session.id,
    stripeSessionUrl: session.url,
    checkoutAmount: grandTotal,
    checkoutCurrency: currency,
    status: "pending",
    // Stripe may not provide payment_intent until completion; store later in finalizePaidOrder
  };
  await order.save();

  return session.url;
}

async function finalizeFreeOrder(order, currency) {
  const paidAt = new Date();

  const result = await withRequiredTransaction(async (session) => {
    const fresh = await applyQueryBudget(
      Order.findOne({ _id: order._id, status: "pending_payment" }).session(session),
    );
    if (!fresh) return null;

    fresh.payment = fresh.payment || {};
    fresh.payment.provider = "free";
    fresh.payment.paidAt = paidAt;
    fresh.payment.amountCaptured = 0;
    fresh.payment.currency = currency;
    fresh.payment.status = "captured";

    fresh.statusHistory = fresh.statusHistory || [];
    fresh.statusHistory.push({ status: "payment_received", at: paidAt, note: "free:checkout" });
    assertOrderTransition(fresh.status, ORDER_STATUS.PAYMENT_RECEIVED);
    fresh.status = ORDER_STATUS.PAYMENT_RECEIVED;

    try {
      await confirmStock(fresh._id, fresh.items, { session, requireActive: true, allowLegacy: true });
      fresh.stock = fresh.stock || {};
      fresh.stock.status = "confirmed";
      fresh.stock.confirmedAt = new Date();
      fresh.stock.lastError = null;
      assertOrderTransition(fresh.status, ORDER_STATUS.STOCK_CONFIRMED);
      fresh.status = ORDER_STATUS.STOCK_CONFIRMED;
      fresh.statusHistory.push({ status: "stock_confirmed", at: new Date(), note: "stock:confirmed" });
    } catch (e) {
      fresh.stock = fresh.stock || {};
      fresh.stock.status = "confirm_failed";
      fresh.stock.lastError = String(e?.message || e).slice(0, 200);
      fresh.stock.confirmAttempts = (fresh.stock.confirmAttempts || 0) + 1;
      fresh.status = "payment_received";
      fresh.statusHistory.push({
        status: "payment_received",
        at: new Date(),
        note: `stock_confirm_failed:${fresh.stock.lastError}`,
      });
    }

    await fresh.save({ session });
    return fresh;
  });

  if (result?.status === "stock_confirmed") {
    await enqueueJob({
      name: "invoice_email",
      payload: { orderId: String(result._id) },
      dedupeKey: `invoice:${String(result._id)}`,
      runAt: new Date(),
      maxAttempts: 8,
    });
    await confirmCouponForPaidOrder(result._id);
    await confirmPromotionsForOrder(result._id);
  }
}

async function markStockConfirmFailed(orderId, err) {
  const msg = String(err?.message || err);
  await Order.updateOne(
    { _id: orderId, status: { $in: ["paid", "payment_received"] } },
    {
      $set: {
        status: "payment_received",
        "stock.status": "confirm_failed",
        "stock.lastError": msg.slice(0, 200),
      },
      $inc: { "stock.confirmAttempts": 1 },
    },
  );
}

export async function confirmPaidOrderStock(orderId, { session } = {}) {
  const work = async (s) => {
    const order = await applyQueryBudget(Order.findById(orderId).session(s));
    if (!order) return false;
    if (order.status !== "payment_received" && order.status !== "paid") return false;
    if (order.stock?.status === "confirmed") return true;
    if (order.stock?.status === "released") {
      const err = new Error("STOCK_ALREADY_RELEASED");
      err.statusCode = 409;
      throw err;
    }

    await confirmStock(order._id, order.items, { session: s, requireActive: true, allowLegacy: true });

    order.stock = order.stock || {};
    order.stock.status = "confirmed";
    order.stock.confirmedAt = new Date();
    order.stock.lastError = null;
    assertOrderTransition(order.status, ORDER_STATUS.STOCK_CONFIRMED);
    order.status = ORDER_STATUS.STOCK_CONFIRMED;
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({ status: "stock_confirmed", at: new Date(), note: "stock:confirmed" });
    await order.save({ session: s });
    return true;
  };

  if (session) return await work(session);
  return await withRequiredTransaction(work);
}

/**
 * Called from Stripe webhook: checkout.session.completed
 * Must be idempotent + atomic state transition.
 *
 * IMPORTANT:
 * - We store stripePaymentIntentId (NOT stripePaymentIntent)
 * - We enqueue invoice job via Phase 4 jobRunner (enqueueJob) with dedupeKey
 */
export async function finalizePaidOrder(session) {
  const orderId = session?.metadata?.orderId;
  if (!orderId) return;

  const paidAt = new Date();
  const stripePaymentIntentId = session.payment_intent ? String(session.payment_intent) : null;

  const amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;
  const sessionCurrency = session.currency ? String(session.currency).toUpperCase() : null;
  const webhookSessionId = session?.id ? String(session.id) : null;

  const result = await withRequiredTransaction(async (s) => {
    const order = await applyQueryBudget(Order.findById(orderId).session(s));
    if (!order) return { status: "missing" };

    const terminal = ["stock_confirmed", "paid", "fulfilled", "partially_refunded", "refunded"];
    if (terminal.includes(order.status)) return { status: "already_confirmed" };

    const allowed = ["pending_payment", "payment_received"];
    if (!allowed.includes(order.status)) {
      order.payment = order.payment || {};
      order.payment.provider = "stripe";
      order.payment.stripePaymentIntentId = stripePaymentIntentId;
      order.payment.stripeSessionId = order.payment.stripeSessionId || webhookSessionId || null;
      order.payment.paidAt = paidAt;
      order.payment.amountCaptured = amountTotal ?? order.payment.amountCaptured;
      order.payment.currency = sessionCurrency || orderCurrency(order);
      order.payment.status = "mismatch";
      order.payment.lastError = `ORDER_STATUS_${order.status}`;
      order.statusHistory = order.statusHistory || [];
      order.statusHistory.push({
        status: "payment_received",
        at: paidAt,
        note: `stripe:unexpected_status:${order.status}`,
      });
      await order.save({ session: s });
      return { status: "mismatch" };
    }

    // Safety net: ensure pricing snapshots are fresh before using Stripe amounts (only while still editable).
    if (order.status === "pending_payment") {
      await repriceOrder(order._id, { session: s });
      const refreshed = await applyQueryBudget(Order.findById(orderId).session(s));
      if (refreshed) order.set(refreshed.toObject());
    }

    const { subtotal, discount, shipping, tax, grandTotal } = computeOrderAmounts(order);
    void subtotal;
    void discount;
    void shipping;
    void tax;

    const expectedCurrency = orderCurrency(order);
    const currencyMismatch =
      sessionCurrency && normalizeCurrency(sessionCurrency) !== expectedCurrency;
    const amountMismatch = amountTotal === null || amountTotal !== grandTotal;
    const storedSessionId = order.payment?.stripeSessionId ? String(order.payment.stripeSessionId) : null;
    const sessionMismatch =
      storedSessionId && webhookSessionId && storedSessionId !== webhookSessionId;

    order.payment = order.payment || {};
    order.payment.provider = "stripe";
    order.payment.paidAt = paidAt;
    order.payment.stripePaymentIntentId = stripePaymentIntentId;
    order.payment.stripeSessionId = order.payment.stripeSessionId || webhookSessionId || null;
    order.payment.amountCaptured = amountTotal ?? order.payment.amountCaptured;
    order.payment.currency = sessionCurrency || expectedCurrency;
    order.payment.status = "captured";
    order.payment.lastError = null;

    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({
      status: "payment_received",
      at: paidAt,
      note: "stripe:checkout.session.completed",
    });
    assertOrderTransition(order.status, ORDER_STATUS.PAYMENT_RECEIVED);
    order.status = ORDER_STATUS.PAYMENT_RECEIVED;
    order.stock = order.stock || {};
    order.stock.status = order.stock.status || "reserved";
    order.stock.lastError = null;

    if (currencyMismatch || amountMismatch || sessionMismatch) {
      const mismatchCode = sessionMismatch
        ? "PAYMENT_SESSION_MISMATCH"
        : currencyMismatch
          ? "PAYMENT_CURRENCY_MISMATCH"
          : "PAYMENT_AMOUNT_MISMATCH";
      order.payment.status = "mismatch";
      order.payment.lastError = mismatchCode;

      try {
        await releaseReservedStockBulk(order._id, order.items || [], {
          session: s,
          requireActive: false,
          reason: "payment_mismatch",
          allowLegacy: true,
        });
        order.stock.status = "released";
        order.stock.releasedAt = new Date();
      } catch (e) {
        order.stock.status = "confirm_failed";
        order.stock.lastError = String(e?.message || e).slice(0, 200);
      }

      if (order.coupon?.code) {
        try {
          await removeCouponFromOrder({
            orderId: order._id,
            auth: { role: "system" },
            _internal: true,
            options: { session: s },
          });
        } catch {
          // best-effort
        }
      }

      await order.save({ session: s });
      return { status: "mismatch" };
    }

    try {
      await confirmStock(order._id, order.items, { session: s, requireActive: true, allowLegacy: true });
      order.stock.status = "confirmed";
      order.stock.confirmedAt = new Date();
      order.stock.lastError = null;
      assertOrderTransition(order.status, ORDER_STATUS.STOCK_CONFIRMED);
      order.status = ORDER_STATUS.STOCK_CONFIRMED;
      order.statusHistory.push({ status: "stock_confirmed", at: new Date(), note: "stock:confirmed" });
    } catch (e) {
      order.stock.status = "confirm_failed";
      order.stock.lastError = String(e?.message || e).slice(0, 200);
      order.stock.confirmAttempts = (order.stock.confirmAttempts || 0) + 1;
      order.status = "payment_received";
      order.statusHistory.push({
        status: "payment_received",
        at: new Date(),
        note: `stock_confirm_failed:${order.stock.lastError}`,
      });
    }

    await order.save({ session: s });
    return { status: order.status };
  });

  if (result?.status === "stock_confirmed") {
    await enqueueJob({
      name: "invoice_email",
      payload: { orderId: String(orderId) },
      dedupeKey: `invoice:${String(orderId)}`,
      runAt: new Date(),
      maxAttempts: 8,
    });
    await confirmCouponForPaidOrder(orderId);
    await confirmPromotionsForOrder(orderId);
    void enqueueOrderNotification({
      orderId,
      event: "order_paid",
      dedupeKey: `notify:order_paid:${String(orderId)}`,
      meta: { source: "stripe_webhook" },
    }).catch(() => {});
    return;
  }

  if (result?.status === "payment_received") {
    void enqueueOrderNotification({
      orderId,
      event: "order_paid",
      dedupeKey: `notify:order_paid:${String(orderId)}`,
      meta: { source: "stripe_webhook", stock: "confirm_failed" },
    }).catch(() => {});
  }

  if (result?.status === "mismatch" || result?.status === "payment_received") {
    await sendAlertOnce({
      key: `payment_issue:${String(orderId)}`,
      subject: `Payment issue for order ${String(orderId)}`,
      text: `Order ${String(orderId)} requires review: status=${result?.status || "unknown"}.`,
      meta: { orderId: String(orderId), status: result?.status },
    });
  }
}

async function cancelOrderAndRelease({ orderId, expectedStatus, reason, canceledBy, note, allowReleaseMismatch = false }) {
  return await withRequiredTransaction(async (session) => {
    const order = await applyQueryBudget(
      Order.findOne({ _id: orderId, status: expectedStatus }).session(session),
    );
    if (!order) return null;

    const now = new Date();

    const shouldRelease = order.stock?.status === "reserved";
    if (shouldRelease) {
      try {
        await releaseReservedStockBulk(order._id, order.items || [], {
          session,
          requireActive: false,
          reason: reason || "",
          allowLegacy: true,
        });
        order.stock = order.stock || {};
        order.stock.status = "released";
        order.stock.releasedAt = now;
        order.stock.lastError = null;
      } catch (e) {
        if (!allowReleaseMismatch) throw e;
        order.stock = order.stock || {};
        order.stock.status = "confirm_failed";
        order.stock.lastError = String(e?.message || e).slice(0, 200);
      }
    }

    if (order.coupon?.code) {
      try {
        await removeCouponFromOrder({
          orderId: order._id,
          auth: { role: "system" },
          _internal: true,
          options: { session },
        });
      } catch {
        // best-effort; do not block cancel
      }
    }

    if (Array.isArray(order.promotions) && order.promotions.length) {
      try {
        await releasePromotionsForOrder({ orderId: order._id, session });
      } catch {
        // best-effort; do not block cancel
      }
    }

    assertOrderTransition(order.status, ORDER_STATUS.CANCELLED);
    order.status = ORDER_STATUS.CANCELLED;
    order.cancel = order.cancel || {};
    order.cancel.canceledAt = now;
    order.cancel.canceledBy = canceledBy;
    order.cancel.reason = reason || "";
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({ status: "cancelled", at: now, note: note || "" });

    await order.save({ session });
    return order;
  });
}

export async function reconcilePaidOrders({ limit = 50 } = {}) {
  const orders = await applyQueryBudget(
    Order.find(
      {
        status: { $in: ["payment_received", "paid"] },
        $or: [{ "stock.status": { $ne: "confirmed" } }, { stock: { $exists: false } }],
      },
      { _id: 1 },
    )
      .limit(Math.max(1, Math.min(500, Number(limit) || 50)))
      .lean(),
  );

  let confirmed = 0;

  for (const o of orders) {
    try {
      const ok = await confirmPaidOrderStock(String(o._id));
      if (ok) {
        confirmed += 1;
        await confirmCouponForPaidOrder(o._id);
        await confirmPromotionsForOrder(o._id);
      }
    } catch (e) {
      await markStockConfirmFailed(o._id, e);
    }
  }

  return { attempted: orders.length, confirmed };
}

export async function cancelStaleDraftOrders({ limit = 50 } = {}) {
  const ttlMinutes = Number(ENV.DRAFT_ORDER_TTL_MINUTES || 60);
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000);

  const orders = await applyQueryBudget(
    Order.find(
      { status: "draft", updatedAt: { $lte: cutoff } },
      { _id: 1 },
    )
      .sort({ updatedAt: 1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 50)))
      .lean(),
  );

  for (const o of orders) {
    try {
      await cancelOrderAndRelease({
        orderId: o._id,
        expectedStatus: "draft",
        reason: "expired_draft",
        canceledBy: "system",
        note: "system:draft_expired",
        allowReleaseMismatch: true,
      });
    } catch {
      // best-effort; do not stop sweep
    }
  }

  return orders.length;
}

/**
 * Phase 4 compatible cancel sweep:
 * - cancels pending_payment orders past expiresAt
 * - releases reserved stock in BULK
 * - sets cancel.* fields (not legacy canceledAt/cancelReason)
 * - best-effort expire stripe session to reduce late payments
 */
export async function cancelExpiredOrders({ limit = 50 } = {}) {
  const now = new Date();

  const orders = await applyQueryBudget(
    Order.find(
      { status: "pending_payment", expiresAt: { $lte: now } },
      { _id: 1, items: 1, "payment.stripeSessionId": 1 },
    )
      .sort({ expiresAt: 1 })
      .limit(Math.max(1, Math.min(500, Number(limit) || 50)))
      .lean(),
  );

  for (const o of orders) {
    let updated = null;
    try {
      updated = await cancelOrderAndRelease({
        orderId: o._id,
        expectedStatus: "pending_payment",
        reason: "expired",
        canceledBy: "system",
        note: "system:expired",
      });
    } catch {
      // best-effort; do not crash sweep
      continue;
    }

    if (!updated) continue;

    // Best-effort expire checkout session (prevents late pay attempts)
    const sid = o?.payment?.stripeSessionId;
    if (sid) {
      try {
        await stripe.checkout.sessions.expire(sid);
      } catch {
        // ignore
      }
    }
  }

  return orders.length;
}
