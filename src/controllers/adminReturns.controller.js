import {
  adminListReturns as adminListReturnsSvc,
  adminGetReturn as adminGetReturnSvc,
  adminDecide as adminDecideSvc,
  adminMarkReceived as adminMarkReceivedSvc,
  adminClose as adminCloseSvc,
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

export async function adminListReturns(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListReturnsSvc({ q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminGetReturn(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const out = await adminGetReturnSvc(id, { ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminDecision(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};
  try {
    const out = await adminDecideSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_RETURN_DECISION,
      { type: "ReturnRequest", id },
      { meta: { decision: body.decision, noteLen: String(body.note || "").length }, message: "Admin return decision" },
    );

    void enqueueReturnNotification({
      returnId: id,
      event: `admin_decision:${String(body.decision || "")}`,
      dedupeKey: req.idempotencyKey ? `notify:return_decision:${String(id)}:${req.idempotencyKey}` : null,
      meta: { decision: body.decision, requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_RETURN_DECISION, { type: "ReturnRequest", id }, err, {
      meta: { decision: body.decision },
    });
    throw err;
  }
}

export async function adminMarkReceived(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};
  try {
    const out = await adminMarkReceivedSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_RETURN_RECEIVED,
      { type: "ReturnRequest", id },
      { meta: { noteLen: String(body.note || "").length }, message: "Admin marked return received" },
    );

    void enqueueReturnNotification({
      returnId: id,
      event: "received",
      dedupeKey: req.idempotencyKey ? `notify:return_received:${String(id)}:${req.idempotencyKey}` : null,
      meta: { requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_RETURN_RECEIVED, { type: "ReturnRequest", id }, err);
    throw err;
  }
}

export async function adminClose(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};
  try {
    const out = await adminCloseSvc(id, body, ctx(req));

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_RETURN_CLOSE,
      { type: "ReturnRequest", id },
      { meta: { status: body.status, noteLen: String(body.note || "").length }, message: "Admin closed return" },
    );

    void enqueueReturnNotification({
      returnId: id,
      event: `closed:${String(body.status || "")}`,
      dedupeKey: req.idempotencyKey ? `notify:return_close:${String(id)}:${req.idempotencyKey}` : null,
      meta: { status: body.status, requestId: req.auditCtx?.requestId || null },
    }).catch(() => {});

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_RETURN_CLOSE, { type: "ReturnRequest", id }, err, {
      meta: { status: body.status },
    });
    throw err;
  }
}
