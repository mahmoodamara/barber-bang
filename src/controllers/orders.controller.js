import { Order } from "../models/Order.js";
import { createDraftOrder } from "../services/orderDraft.service.js"; // Phase 3
import { startCheckout } from "../services/payment.service.js";
import { cancelOrderByUser } from "../services/cancel.service.js";
import { formatOrderForResponse } from "../utils/orderResponse.js";
import { parsePagination } from "../utils/paginate.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";
import { quoteOrder } from "../services/orderQuote.service.js";
import { updateOrderAddresses } from "../services/orderAddress.service.js";
import { enqueueOrderNotification } from "../services/notification.service.js";

export async function createOrder(req, res) {
  try {
    const order = await createDraftOrder({
      userId: req.auth.userId,
      lang: req.lang,
      body: req.validated?.body ?? req.body,
    });

    await logAuditSuccess(req, AuditActions.ORDER_CREATE_DRAFT, {
      type: "Order",
      id: String(order._id),
    }, { message: `Draft order ${order.orderNumber} created` });

    // Best-effort notification (never blocks order creation)
    void enqueueOrderNotification({
      orderId: order._id || order.id,
      event: "order_placed",
      dedupeKey: `notify:order_placed:${String(order._id || order.id)}`,
      meta: { requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    res.status(201).json({ ok: true, order: formatOrderForResponse(order) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_CREATE_DRAFT, { type: "Order" }, err);
    throw err;
  }
}

export async function createCheckout(req, res) {
  try {
    const url = await startCheckout({
      req,
      orderId: req.params.id,
      userId: req.auth.userId,
    });

    await logAuditSuccess(req, AuditActions.ORDER_CHECKOUT_START, {
      type: "Order",
      id: req.params.id,
    });

    res.json({ ok: true, checkoutUrl: url });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_CHECKOUT_START, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}

export async function getMyOrders(req, res) {
  const { page, limit, skip } = parsePagination(req.query, { maxLimit: 50, defaultLimit: 20 });
  const fields =
    "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory createdAt updatedAt";

  const [items, total] = await Promise.all([
    Order.find({ userId: req.auth.userId })
      .select(fields)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments({ userId: req.auth.userId }),
  ]);

  res.json({
    ok: true,
    page,
    limit,
    total,
    items: items.map((o) => formatOrderForResponse(o)),
  });
}

export async function getOrder(req, res) {
  const fields =
    "orderNumber userId guestEmail lang status items pricing coupon promotionCode promotions shippingAddress billingAddress shippingMethod " +
    "expiresAt payment invoiceStatus invoiceRef invoiceUrl invoiceIssuedAt cancel refund statusHistory createdAt updatedAt";
  const order = await Order.findOne({ _id: req.params.id, userId: req.auth.userId })
    .select(fields)
    .lean();
  if (!order) {
    const err = new Error("ORDER_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }
  res.json({ ok: true, order: formatOrderForResponse(order) });
}

export async function cancelOrder(req, res) {
  try {
    const order = await cancelOrderByUser({
      orderId: req.params.id,
      userId: req.auth.userId,
      reason: req.validated?.body?.reason,
    });

    await logAuditSuccess(req, AuditActions.ORDER_CANCEL, {
      type: "Order",
      id: req.params.id,
    }, { message: `Order cancelled: ${req.validated?.body?.reason || "No reason"}` });

    res.json({ ok: true, order: formatOrderForResponse(order) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_CANCEL, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}

export async function getOrderQuote(req, res) {
  const quote = await quoteOrder({
    orderId: req.params.id,
    userId: req.auth.userId,
    lang: req.lang,
  });
  res.json({ ok: true, quote });
}

export async function patchOrderAddress(req, res) {
  const updated = await updateOrderAddresses({
    orderId: req.params.id,
    userId: req.auth.userId,
    patch: req.validated?.body ?? req.body,
  });
  res.json({ ok: true, order: formatOrderForResponse(updated) });
}
