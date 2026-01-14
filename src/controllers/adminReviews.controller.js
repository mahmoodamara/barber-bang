// src/controllers/adminReviews.controller.js
import mongoose from "mongoose";
import {
  adminListReviews as adminListReviewsSvc,
  adminApproveReview as adminApproveReviewSvc,
  adminRejectReview as adminRejectReviewSvc,
} from "../services/review.service.js";
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
 * Admin - Reviews Moderation
 * Expected by admin.reviews.routes.js:
 * - adminListReviews
 * - adminApproveReview
 * - adminRejectReview
 */

export async function adminListReviews(req, res) {
  const q = req.validated?.query || req.query || {};
  const out = await adminListReviewsSvc({ auth: req.auth, q, ctx: ctx(req) });
  return res.json({ ok: true, data: out });
}

export async function adminApproveReview(req, res) {
  const reviewId = requireObjectId(req.params.id, "INVALID_REVIEW_ID");
  try {
    const out = await adminApproveReviewSvc({ reviewId, auth: req.auth, ctx: ctx(req) });

    await logAuditSuccess(req, AuditActions.ADMIN_REVIEW_APPROVE, {
      type: "Review",
      id: reviewId,
    }, { message: "Review approved" });

    return res.json({ ok: true, data: { review: out } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_REVIEW_APPROVE, { type: "Review", id: reviewId }, err);
    throw err;
  }
}

export async function adminRejectReview(req, res) {
  const reviewId = requireObjectId(req.params.id, "INVALID_REVIEW_ID");
  const body = req.validated?.body || {};
  const reason = String(body.reason || "").trim();
  if (!reason) throw httpError(400, "REJECT_REASON_REQUIRED", "reason is required");

  try {
    const out = await adminRejectReviewSvc({ reviewId, auth: req.auth, reason, ctx: ctx(req) });

    await logAuditSuccess(req, AuditActions.ADMIN_REVIEW_REJECT, {
      type: "Review",
      id: reviewId,
    }, { message: `Review rejected: ${reason}` });

    return res.json({ ok: true, data: { review: out } });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_REVIEW_REJECT, { type: "Review", id: reviewId }, err);
    throw err;
  }
}

/**
 * Backward-compat aliases (optional):
 * If some route imports different names, uncomment:
 *
 * export { adminListReviews as listAdminReviews };
 * export { adminApproveReview as approveReview };
 * export { adminRejectReview as rejectReview };
 */
