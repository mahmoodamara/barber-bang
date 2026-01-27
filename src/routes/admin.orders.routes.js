// src/routes/admin.orders.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Order } from "../models/Order.js";
import { requireAuth, requireRole, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { mapOrder } from "../utils/mapOrder.js";
import { sendOk, sendError } from "../utils/response.js";
import {
  ORDER_STATUSES,
  isValidTransition,
  updateOrderStatus,
  updateOrderShipping,
  cancelOrder,
  processRefund,
  issueOrderInvoice,
} from "../services/admin-orders.service.js";

const router = express.Router();

// Auth + Role: admin or staff with ORDERS_WRITE permission
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.ORDERS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonRes(res, data, meta = null) {
  return sendOk(res, data, meta);
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message);
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

/* ============================
   Schemas
============================ */

const listQuerySchema = z.object({
  query: z
    .object({
      status: z.string().optional(),
      paymentMethod: z.enum(["stripe", "cod"]).optional(),
      q: z.string().max(120).optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
      // ✅ Safe sorting with allowlist only
      sortBy: z.enum(["createdAt", "updatedAt", "status", "paymentMethod", "totalMinor", "orderNumber"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
      lang: z.string().optional(),
    })
    .strict() // Reject unknown query fields
    .optional(),
});

const statusUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      status: z.enum(ORDER_STATUSES),
    })
    .strict(),
});

const shippingUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      carrier: z.string().min(1).max(100).optional(),
      trackingNumber: z.string().min(1).max(100).optional(),
      shippedAt: z.string().datetime().optional(),
    })
    .strict(),
});

const cancelSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      reason: z.string().min(1).max(400),
      restock: z.boolean().optional(),
    })
    .strict(),
});

const refundSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      amount: z.number().min(0).optional(),
      reason: z.enum(["customer_cancel", "return", "out_of_stock", "fraud", "duplicate", "other"]).optional(),
      note: z.string().max(400).optional(),
    })
    .strict(),
});

const invoiceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

const resendEmailSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      type: z.enum(["confirmation", "shipping", "invoice"]).optional(),
    })
    .strict()
    .optional(),
});

/* ============================
   GET /api/admin/orders
============================ */

router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.status) {
      const statuses = q.status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        filter.status = statuses[0];
      } else if (statuses.length > 1) {
        filter.status = { $in: statuses };
      }
    }

    if (q.paymentMethod) {
      filter.paymentMethod = q.paymentMethod;
    }

    if (q.dateFrom || q.dateTo) {
      filter.createdAt = {};
      if (q.dateFrom) {
        filter.createdAt.$gte = new Date(q.dateFrom);
      }
      if (q.dateTo) {
        filter.createdAt.$lte = new Date(q.dateTo);
      }
    }

    // Search by order number, user email, or phone
    if (q.q) {
      const search = String(q.q).trim().slice(0, 120);
      if (search) {
        const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [
          { orderNumber: regex },
          { "shipping.phone": regex },
          { "shipping.address.phone": regex },
        ];

        // Also search by _id if it looks like ObjectId
        if (isValidObjectId(search)) {
          filter.$or.push({ _id: search });
        }
      }
    }

    // ✅ Safe sorting with allowlist - default to createdAt desc
    let sortOption = { createdAt: -1 };
    if (q.sortBy) {
      const dir = q.sortDir === "asc" ? 1 : -1;
      // sortBy is already validated by Zod enum, safe to use
      if (q.sortBy === "totalMinor") {
        sortOption = { "pricingMinor.total": dir };
      } else {
        sortOption = { [q.sortBy]: dir };
      }
    }

    const [items, total] = await Promise.all([
      Order.find(filter)
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email")
        .lean(),
      Order.countDocuments(filter),
    ]);

    const mapped = items.map((o) => ({
      ...mapOrder(o, { lang: req.lang }),
      user: o.userId
        ? {
          id: o.userId._id,
          name: o.userId.name || "",
          email: o.userId.email || "",
        }
        : null,
    }));

    return jsonRes(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/admin/orders/:id
============================ */

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Order not found");
    }

    const item = await Order.findById(id).populate("userId", "name email phone");
    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "Order not found");
    }

    const mapped = mapOrder(item, { lang: req.lang });
    mapped.user = item.userId
      ? {
        id: item.userId._id,
        name: item.userId.name || "",
        email: item.userId.email || "",
      }
      : null;

    return jsonRes(res, mapped);
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/orders/:id/status
============================ */

router.patch("/:id/status", validate(statusUpdateSchema), async (req, res) => {
  try {
    const { order } = await updateOrderStatus(
      req.params.id,
      req.validated.body.status,
      { validateTransition: true, lang: req.lang }
    );
    return jsonRes(res, mapOrder(order, { lang: req.lang }));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/orders/:id/shipping
============================ */

router.patch("/:id/shipping", validate(shippingUpdateSchema), async (req, res) => {
  try {
    const order = await updateOrderShipping(req.params.id, req.validated.body);
    return jsonRes(res, mapOrder(order, { lang: req.lang }));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/orders/:id/cancel
============================ */

router.post("/:id/cancel", validate(cancelSchema), async (req, res) => {
  try {
    const { reason, restock } = req.validated.body;
    const { order, restocked } = await cancelOrder(req.params.id, { reason, restock });
    return jsonRes(res, {
      ...mapOrder(order, { lang: req.lang }),
      restocked,
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/orders/:id/refund
============================ */

router.post("/:id/refund", validate(refundSchema), async (req, res) => {
  try {
    const idemKey = pickIdempotencyKey(req);
    const { amount, reason, note } = req.validated.body;

    const result = await processRefund(req.params.id, {
      amount,
      reason,
      note,
      idempotencyKey: idemKey,
    });

    if (result.alreadyRefunded) {
      return jsonRes(res, mapOrder(result.order, { lang: req.lang }));
    }

    if (result.pendingManualAction) {
      return res.status(202).json({
        ok: true,
        success: true,
        data: {
          ...mapOrder(result.order, { lang: req.lang }),
          warning: "REFUND_PENDING_MANUAL_ACTION",
        },
      });
    }

    return jsonRes(res, {
      ...mapOrder(result.order, { lang: req.lang }),
      ...(result.manualRefund ? { manualRefund: true } : {}),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/orders/:id/issue-invoice
============================ */

router.post("/:id/issue-invoice", validate(invoiceSchema), async (req, res) => {
  try {
    const result = await issueOrderInvoice(req.params.id);

    if (result.alreadyIssued) {
      return jsonRes(res, {
        ...mapOrder(result.order, { lang: req.lang }),
        invoiceAlreadyIssued: true,
      });
    }

    return jsonRes(res, mapOrder(result.order, { lang: req.lang }));
  } catch (e) {
    // If invoice failed but we have an order, return it with the error
    if (e.order) {
      return res.status(e.statusCode || 500).json({
        ok: false,
        success: false,
        error: {
          code: e.code || "INVOICE_FAILED",
          message: e.message || "Failed to issue invoice",
          requestId: getRequestId(req),
          path: req?.originalUrl || req?.url || "",
        },
        data: mapOrder(e.order, { lang: req.lang }),
      });
    }
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/orders/:id/resend-email
   TODO: Implement with actual mailer when available
============================ */

router.post("/:id/resend-email", validate(resendEmailSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Order not found");
    }

    const order = await Order.findById(id);
    if (!order) {
      return safeNotFound(res, "NOT_FOUND", "Order not found");
    }

    const type = req.validated?.body?.type || "confirmation";

    // TODO: Implement actual email sending when mailer service is available
    // For now, return stub response indicating email would be sent

    return jsonRes(res, {
      orderId: order._id,
      emailType: type,
      status: "stub",
      message: "Email sending not implemented. TODO: integrate with mailer service.",
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
