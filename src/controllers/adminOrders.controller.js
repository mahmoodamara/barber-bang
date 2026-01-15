import {
  adminAddOrderNote as adminAddOrderNoteSvc,
  adminGetOrder as adminGetOrderSvc,
  adminListOrders as adminListOrdersSvc,
  adminResolvePayment as adminResolvePaymentSvc,
  adminUpdateOrderStatus as adminUpdateOrderStatusSvc,
  adminUpdateOrderTracking as adminUpdateOrderTrackingSvc,
} from "../services/adminOrders.service.js";
import { logAuditFail, logAuditSuccess, AuditActions } from "../services/audit.service.js";

function ctx(req) {
  return {
    actorId: req.auth?.userId || null,
    roles: req.auth?.roles || [],
    requestId: req.requestId || req.id || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
  };
}

export async function adminListOrders(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListOrdersSvc({ q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminGetOrder(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const out = await adminGetOrderSvc(id, { ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminUpdateOrderStatus(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};

  try {
    const out = await adminUpdateOrderStatusSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_ORDER_STATUS_UPDATE,
      { type: "Order", id },
      { meta: { status: body.status, reason: body.reason || null }, message: "Admin order status update" },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_ORDER_STATUS_UPDATE, { type: "Order", id }, err, {
      meta: { status: body.status, reason: body.reason || null },
    });
    throw err;
  }
}

export async function adminUpdateOrderTracking(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};

  try {
    const out = await adminUpdateOrderTrackingSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_ORDER_TRACKING_UPDATE,
      { type: "Order", id },
      {
        meta: {
          carrier: body.carrier !== undefined ? body.carrier : undefined,
          hasTrackingNumber: body.trackingNumber !== undefined ? !!body.trackingNumber : undefined,
          hasTrackingUrl: body.trackingUrl !== undefined ? !!body.trackingUrl : undefined,
        },
        message: "Admin order tracking update",
      },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_ORDER_TRACKING_UPDATE, { type: "Order", id }, err);
    throw err;
  }
}

export async function adminAddOrderNote(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};

  try {
    const out = await adminAddOrderNoteSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_ORDER_NOTE_ADD,
      { type: "Order", id },
      { meta: { noteLen: String(body.note || "").length }, message: "Admin order note added" },
    );

    return res.status(201).json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_ORDER_NOTE_ADD, { type: "Order", id }, err);
    throw err;
  }
}

export async function adminResolvePayment(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};

  try {
    const out = await adminResolvePaymentSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_ORDER_PAYMENT_RESOLVE,
      { type: "Order", id },
      { meta: { action: body.action, noteLen: String(body.note || "").length }, message: "Admin payment resolution" },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_ORDER_PAYMENT_RESOLVE, { type: "Order", id }, err, {
      meta: { action: body.action },
    });
    throw err;
  }
}
