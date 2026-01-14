// src/controllers/adminOps.controller.js
import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { Job } from "../models/Job.js";
import { StripeEvent } from "../models/StripeEvent.js";
import { adminRefundOrder } from "../services/refund.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function requireObjectId(id, code = "INVALID_ID") {
  const v = String(id || "");
  if (!isValidObjectId(v)) throw httpError(400, code, code);
  return v;
}

function actorCtx(req) {
  return {
    actorId: req.auth?.userId || null,
    requestId: req.requestId || null,
    ip: req.ip || null,
    userAgent: req.headers?.["user-agent"] || null,
    email: req.auth?.email || null,
    roles: req.auth?.roles || [],
  };
}

/**
 * Admin refund endpoint:
 * - Validates :id ObjectId (fail fast)
 * - Passes structured ctx for audit logging in service
 * - Enforces consistent response envelope
 */
export async function adminRefund(req, res) {
  const orderId = requireObjectId(req.params.id, "INVALID_ORDER_ID");

  const result = await adminRefundOrder({
    req, // keep for backward compatibility if service relies on it
    orderId,
    actorId: req.auth?.userId,
    body: req.validated.body,
    ctx: actorCtx(req),
  });

  // Backward compatibility:
  // - If service already returns { ok:true, ... }, wrap into { ok:true, data: ... }
  // - If it returns plain data, wrap as well.
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "ok")) {
    if (result.ok === true && !Object.prototype.hasOwnProperty.call(result, "data")) {
      const { ok: _ok, ...rest } = result;
      return ok(res, rest);
    }
    return res.json(result); // already correctly wrapped
  }

  return ok(res, result);
}

/**
 * Ops summary:
 * - Keeps response keys stable (canceled key maps to cancelled status internally)
 * - Consistent envelope: { ok:true, data:{...} }
 */
export async function opsSummary(_req, res) {
  const [pending, paid, canceled, refunded, failedJobs, unprocessedStripe] = await Promise.all([
    Order.countDocuments({ status: "pending_payment" }),
    Order.countDocuments({
      status: { $in: ["payment_received", "stock_confirmed", "paid", "fulfilled"] },
    }),
    // NOTE: internal status is "cancelled" (double-L). Keep response key "canceled" for backward compatibility.
    Order.countDocuments({ status: "cancelled" }),
    Order.countDocuments({ status: { $in: ["refunded", "partially_refunded"] } }),
    Job.countDocuments({ status: "failed" }),
    // StripeEvent.status enum: ["received","processed","failed"]
    StripeEvent.countDocuments({ status: { $in: ["received", "failed"] } }),
  ]);

  return ok(res, {
    orders: { pending, paid, canceled, refunded },
    jobs: { failed: failedJobs },
    stripe: { unprocessedEvents: unprocessedStripe },
  });
}
