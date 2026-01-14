import { applyCouponToOrder, removeCouponFromOrder } from "../services/coupon.service.js";
import { formatOrderForResponse } from "../utils/orderResponse.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function pickAuth(req) {
  // Phase 2/3 عادة: req.auth = { userId, role }
  // fallback إن عندك شكل مختلف:
  const a = req.auth || {};
  return {
    userId: a.userId || a.id || null,
    role: a.role || "user",
    _id: a.userId || a.id || null,
  };
}

export async function applyCoupon(req, res) {
  try {
    const order = await applyCouponToOrder({
      orderId: req.params.id,
      auth: pickAuth(req),
      code: req.validated.body.code,
    });

    await logAuditSuccess(req, AuditActions.ORDER_APPLY_COUPON, {
      type: "Order",
      id: req.params.id,
    }, { message: `Applied coupon: ${req.validated.body.code}` });

    const payload = order.toJSON ? order.toJSON() : order;
    res.json({ ok: true, order: formatOrderForResponse(payload) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_APPLY_COUPON, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}

export async function removeCoupon(req, res) {
  try {
    const order = await removeCouponFromOrder({
      orderId: req.params.id,
      auth: pickAuth(req),
    });

    await logAuditSuccess(req, AuditActions.ORDER_REMOVE_COUPON, {
      type: "Order",
      id: req.params.id,
    });

    const payload = order.toJSON ? order.toJSON() : order;
    res.json({ ok: true, order: formatOrderForResponse(payload) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_REMOVE_COUPON, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}
