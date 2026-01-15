import Stripe from "stripe";
import { ENV } from "../utils/env.js";
import { Order } from "../models/Order.js";
import { releaseReservedStockBulk } from "./stock.service.js";
import { removeCouponFromOrder } from "./coupon.service.js";
import { releasePromotionsForOrder } from "./promotion.service.js";
import { assertOrderTransition, ORDER_STATUS } from "../utils/orderState.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";

const stripe = new Stripe(ENV.STRIPE_SECRET_KEY);

export async function cancelOrderByUser({ orderId, userId, reason }) {
  const updated = await withRequiredTransaction(async (session) => {
    const order = await Order.findOne({ _id: orderId, userId }).session(session);
    if (!order) {
      const err = new Error("ORDER_NOT_FOUND");
      err.statusCode = 404;
      throw err;
    }

    // Idempotent: if already cancelled, return current state (cleanup leaked reserve if any)
    if (order.status === "cancelled") {
      if (order.stock?.status === "reserved" || !order.stock) {
        const now = new Date();
        await releaseReservedStockBulk(order._id, order.items || [], {
          session,
          requireActive: false,
          reason: "user_cancel",
          allowLegacy: true,
        });
        order.stock = order.stock || {};
        order.stock.status = "released";
        order.stock.releasedAt = now;
        order.stock.lastError = null;
        await order.save({ session });
      }
      return order;
    }

    // Cannot cancel after payment (use refund flow instead)
    if (["payment_received", "stock_confirmed", "paid", "fulfilled"].includes(order.status)) {
      const err = new Error("ORDER_CANCEL_NOT_ALLOWED");
      err.statusCode = 409;
      throw err;
    }

    if (order.status !== "pending_payment") {
      const err = new Error("ORDER_CANCEL_NOT_ALLOWED");
      err.statusCode = 409;
      throw err;
    }

    const now = new Date();

    if (order.stock?.status === "reserved" || !order.stock) {
      await releaseReservedStockBulk(order._id, order.items || [], {
        session,
        requireActive: false,
        reason: "user_cancel",
        allowLegacy: true,
      });
      order.stock = order.stock || {};
      order.stock.status = "released";
      order.stock.releasedAt = now;
      order.stock.lastError = null;
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

    order.status = ORDER_STATUS.CANCELLED;
    order.cancel = order.cancel || {};
    order.cancel.canceledAt = now;
    order.cancel.canceledBy = "user";
    order.cancel.reason = reason || "";
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({ status: "cancelled", at: now, note: "user:cancel" });

    await order.save({ session });
    return order;
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

  return updated.toObject();
}
