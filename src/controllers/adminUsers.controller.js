import {
  adminCreatePasswordResetToken as adminCreatePasswordResetTokenSvc,
  adminGetUser as adminGetUserSvc,
  adminListUsers as adminListUsersSvc,
  adminUpdateUser as adminUpdateUserSvc,
} from "../services/adminUsers.service.js";
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

export async function adminListUsers(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListUsersSvc({ q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminGetUser(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const out = await adminGetUserSvc(id, { ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminUpdateUser(req, res) {
  const id = req.validated?.params?.id || req.params?.id;
  const body = req.validated?.body || {};

  try {
    const out = await adminUpdateUserSvc(id, body, { ctx: ctx(req) });

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_USER_UPDATE,
      { type: "User", id },
      { meta: { patch: body }, message: "Admin user update" },
    );

    return res.json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_USER_UPDATE, { type: "User", id }, err, {
      meta: { patch: body },
    });
    throw err;
  }
}

export async function adminResetUserPassword(req, res) {
  const id = req.validated?.params?.id || req.params?.id;

  try {
    const out = await adminCreatePasswordResetTokenSvc(id, {
      ip: req.ip || null,
      userAgent: req.headers?.["user-agent"] || null,
    });

    await logAuditSuccess(
      req,
      AuditActions.ADMIN_USER_RESET_PASSWORD,
      { type: "User", id },
      { meta: { expiresAt: out.expiresAt }, message: "Admin password reset token issued" },
    );

    return res.status(201).json({ ok: true, data: out });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_USER_RESET_PASSWORD, { type: "User", id }, err);
    throw err;
  }
}

