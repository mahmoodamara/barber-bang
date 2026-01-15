// src/controllers/orderShipping.controller.js
import { setOrderShippingMethodSchema } from "../validators/shipping.validators.js";
import { listShippingMethodsForOrder, setOrderShippingMethod } from "../services/shipping.service.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function pickAuth(req) {
  const a = req.auth || {};
  return { userId: a.userId || a.id || a._id, roles: a.roles || [] };
}

export async function listForOrder(req, res) {
  const auth = pickAuth(req);
  const out = await listShippingMethodsForOrder({ orderId: req.params.id, auth, lang: req.lang });
  return res.status(200).json({
    ok: true,
    data: {
      methods: out.methods,
      payableSubtotal: out.payableSubtotal,
      payableSubtotalMinor: out.payableSubtotalMinor,
      city: out.city,
    },
  });
}

export async function setForOrder(req, res) {
  const auth = pickAuth(req);
  const body = req.validated?.body || setOrderShippingMethodSchema.parse(req.body || {});

  try {
    const out = await setOrderShippingMethod({
      orderId: req.params.id,
      auth,
      shippingMethodId: body.shippingMethodId,
      lang: req.lang,
    });

    await logAuditSuccess(req, AuditActions.ORDER_SET_SHIPPING, {
      type: "Order",
      id: req.params.id,
    }, { message: `Set shipping method: ${body.shippingMethodId}` });

    return res.status(200).json({ ok: true, data: { order: out } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ORDER_SET_SHIPPING, {
      type: "Order",
      id: req.params.id,
    }, err);
    throw err;
  }
}
