// src/routes/admin.approvals.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { AdminApproval } from "../models/AdminApproval.js";
import { requireAuth, requireRole, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { processRefund } from "../services/admin-orders.service.js";

const router = express.Router();

router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.REFUNDS_WRITE));
router.use(auditAdmin());

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

const refundItemsSchema = z.array(
  z
    .object({
      productId: z.string().min(1),
      variantId: z.string().optional(),
      qty: z.number().int().min(1).max(999),
      amount: z.number().min(0).optional(),
    })
    .strict()
);

const createSchema = z.object({
  body: z.object({
    actionType: z.literal("REFUND"),
    payload: z.object({
      orderId: z.string().min(1),
      amount: z.number().min(0).nullable().optional(),
      reason: z.string().min(1),
      note: z.string().optional(),
      items: refundItemsSchema.optional().nullable(),
    }),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    status: z.enum(["approved", "rejected"]),
  }),
});

router.get("/", async (req, res) => {
  try {
    const status = req.query.status;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const query = status ? { status } : {};
    const list = await AdminApproval.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("payload.orderId", "orderNumber status pricing")
      .populate("requestedBy", "name email")
      .populate("approvedBy", "name email")
      .lean();
    return sendOk(res, list);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post("/", validate(createSchema), async (req, res) => {
  try {
    const idempotencyKey = pickIdempotencyKey(req);
    const { actionType, payload } = req.validated.body;

    if (actionType !== "REFUND") {
      return sendError(res, 400, "INVALID_ACTION", "Only REFUND is supported");
    }

    const orderId = payload.orderId;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return sendError(res, 400, "INVALID_ORDER_ID", "Invalid orderId");
    }

    if (idempotencyKey) {
      const existing = await AdminApproval.findOne({ idempotencyKey }).lean();
      if (existing) {
        return res.status(200).json({ ok: true, data: existing, alreadyCreated: true });
      }
    }

    const approval = await AdminApproval.create({
      actionType: "REFUND",
      payload: {
        orderId: new mongoose.Types.ObjectId(orderId),
        amount: payload.amount ?? null,
        reason: payload.reason,
        note: payload.note ?? "",
        items: payload.items ?? null,
      },
      status: "pending",
      requestedBy: req.user._id,
      idempotencyKey: idempotencyKey || undefined,
    });

    const populated = await AdminApproval.findById(approval._id)
      .populate("payload.orderId", "orderNumber status pricing")
      .populate("requestedBy", "name email")
      .lean();

    return sendCreated(res, populated);
  } catch (e) {
    if (e?.code === 11000) {
      const existing = await AdminApproval.findOne({ idempotencyKey: pickIdempotencyKey(req) }).lean();
      if (existing) return res.status(200).json({ ok: true, data: existing, alreadyCreated: true });
    }
    return jsonErr(res, e);
  }
});

router.patch("/:id", requireRole("admin"), validate(updateSchema), async (req, res) => {
  try {
    const id = req.validated.params.id;
    const { status } = req.validated.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, "INVALID_ID", "Invalid approval id");
    }

    const approval = await AdminApproval.findById(id);
    if (!approval) {
      return sendError(res, 404, "NOT_FOUND", "Approval not found");
    }

    if (approval.status !== "pending") {
      return sendError(res, 400, "INVALID_STATE", `Approval is already ${approval.status}`);
    }

    if (status === "rejected") {
      approval.status = "rejected";
      approval.approvedBy = req.user._id;
      await approval.save();
      return sendOk(res, approval);
    }

    if (status === "approved") {
      approval.status = "approved";
      approval.approvedBy = req.user._id;
      await approval.save();

      const orderId = approval.payload?.orderId;
      const amount = approval.payload?.amount;
      const reason = approval.payload?.reason ?? "other";
      const note = approval.payload?.note ?? "";
      const items = approval.payload?.items ?? null;

      try {
        const result = await processRefund(orderId, {
          amount: amount ?? undefined,
          reason,
          note,
          items,
          idempotencyKey: `approval:${approval._id}`,
        });

        approval.status = "executed";
        approval.executedAt = new Date();
        approval.executedResult = { success: result.success, alreadyRefunded: result.alreadyRefunded };
        await approval.save();

        return sendOk(res, approval);
      } catch (execErr) {
        approval.executedResult = { error: String(execErr?.message || execErr) };
        await approval.save();
        return sendError(
          res,
          execErr.statusCode || 500,
          execErr.code || "EXECUTE_FAILED",
          String(execErr?.message || "Refund execution failed")
        );
      }
    }

    return jsonErr(res, new Error("Invalid status"));
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
