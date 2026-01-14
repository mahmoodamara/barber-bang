// src/controllers/adminShipping.controller.js
import mongoose from "mongoose";
import {
  adminListShippingMethods as adminListShippingMethodsSvc,
  adminGetShippingMethod as adminGetShippingMethodSvc,
  adminCreateShippingMethod as adminCreateShippingMethodSvc,
  adminUpdateShippingMethod as adminUpdateShippingMethodSvc,
  adminDeactivateShippingMethod as adminDeactivateShippingMethodSvc,
} from "../services/adminShipping.service.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function httpError(statusCode, code, message) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function requireObjectId(id, code = "INVALID_ID") {
  const v = String(id || "");
  if (!mongoose.Types.ObjectId.isValid(v)) throw httpError(400, code, code);
  return v;
}

function ctx(req) {
  return {
    actorId: req.auth?.userId || null,
    roles: req.auth?.roles || [],
    requestId: req.requestId || req.id || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
  };
}

/**
 * NOTE:
 * We keep admin naming in exports to match admin.shipping.routes.js
 * Route handlers should always use req.validated.{query|body} when available.
 */

export async function listAdminShippingMethods(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListShippingMethodsSvc({ q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function getAdminShippingMethod(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_SHIPPING_METHOD_ID");
  const doc = await adminGetShippingMethodSvc(id, { ctx: ctx(req) });
  return res.json({ ok: true, data: { shippingMethod: doc } });
}

export async function createShippingMethod(req, res) {
  const body = req.validated?.body || {};
  try {
    const doc = await adminCreateShippingMethodSvc(body, { ctx: ctx(req) });

    await logAuditSuccess(req, AuditActions.ADMIN_SHIPPING_CREATE, {
      type: "ShippingMethod",
      id: String(doc._id || doc.id),
    }, { message: `Created shipping method: ${doc.name?.he || doc.name || ""}` });

    return res.status(201).json({ ok: true, data: { shippingMethod: doc } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_SHIPPING_CREATE, { type: "ShippingMethod" }, err);
    throw err;
  }
}

export async function updateShippingMethod(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_SHIPPING_METHOD_ID");
  const body = req.validated?.body || {};
  try {
    const doc = await adminUpdateShippingMethodSvc(id, body, { ctx: ctx(req) });

    await logAuditSuccess(req, AuditActions.ADMIN_SHIPPING_UPDATE, {
      type: "ShippingMethod",
      id,
    }, { message: `Updated shipping method: ${doc.name?.he || doc.name || ""}` });

    return res.json({ ok: true, data: { shippingMethod: doc } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_SHIPPING_UPDATE, { type: "ShippingMethod", id }, err);
    throw err;
  }
}

export async function deactivateShippingMethod(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_SHIPPING_METHOD_ID");
  try {
    const doc = await adminDeactivateShippingMethodSvc(id, { ctx: ctx(req) });

    await logAuditSuccess(req, AuditActions.ADMIN_SHIPPING_DELETE, {
      type: "ShippingMethod",
      id,
    }, { message: `Deactivated shipping method: ${doc.name?.he || doc.name || ""}` });

    return res.json({ ok: true, data: { shippingMethod: doc } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_SHIPPING_DELETE, { type: "ShippingMethod", id }, err);
    throw err;
  }
}
