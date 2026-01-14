import {
  createReturnRequest as createReturnRequestSvc,
  listMyReturns as listMyReturnsSvc,
  getMyReturn as getMyReturnSvc,
  cancelReturn as cancelReturnSvc,
} from "../services/returns.service.js";

import { logAuditFail, logAuditSuccess, AuditActions } from "../services/audit.service.js";
import { enqueueReturnNotification } from "../services/notification.service.js";

function ctx(req) {
  return {
    actorId: req.auth?.userId || null,
    roles: req.auth?.roles || [],
    requestId: req.requestId || req.id || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
  };
}

export async function createReturnRequest(req, res) {
  const body = req.validated?.body ?? req.body ?? {};
  try {
    const out = await createReturnRequestSvc(req.auth.userId, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.RETURN_REQUEST_CREATE,
      { type: "ReturnRequest", id: out?.id || null },
      { meta: { orderId: body.orderId, items: Array.isArray(body.items) ? body.items.length : 0 }, message: "Return requested" },
    );

    void enqueueReturnNotification({
      returnId: out?.id,
      event: "created",
      dedupeKey: req.idempotencyKey ? `notify:return_created:${String(out?.id)}:${req.idempotencyKey}` : null,
      meta: { requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    return res.status(201).json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.RETURN_REQUEST_CREATE, { type: "ReturnRequest" }, err, {
      meta: { orderId: body.orderId || null },
    });
    throw err;
  }
}

export async function listMyReturns(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await listMyReturnsSvc({
    userId: req.auth.userId,
    page: q.page,
    limit: q.limit,
    status: q.status,
  });
  return res.json({ ok: true, data: out });
}

export async function getMyReturn(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const out = await getMyReturnSvc({ userId: req.auth.userId, id });
  return res.json({ ok: true, data: out });
}

export async function cancelReturn(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  try {
    const out = await cancelReturnSvc(req.auth.userId, id);

    await logAuditSuccess(
      req,
      AuditActions.RETURN_REQUEST_CANCEL,
      { type: "ReturnRequest", id },
      { message: "Return canceled by customer" },
    );

    void enqueueReturnNotification({
      returnId: id,
      event: "canceled",
      dedupeKey: req.idempotencyKey ? `notify:return_canceled:${String(id)}:${req.idempotencyKey}` : null,
      meta: { requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.RETURN_REQUEST_CANCEL, { type: "ReturnRequest", id }, err);
    throw err;
  }
}
