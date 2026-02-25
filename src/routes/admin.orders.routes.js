// src/routes/admin.orders.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Order } from "../models/Order.js";
import { User } from "../models/User.js";

import {
  requireAuth,
  requirePermission,
  requireAnyPermission,
  PERMISSIONS,
} from "../middleware/auth.js";

import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { mapOrder } from "../utils/mapOrder.js";
import { sendOk, sendError } from "../utils/response.js";

import {
  ORDER_STATUSES,
  updateOrderStatus,
  updateOrderShipping,
  cancelOrder,
  processRefund,
  issueOrderInvoice,
} from "../services/admin-orders.service.js";
import { sendOrderConfirmation } from "../services/email.service.js";
import { log } from "../utils/logger.js";

const router = express.Router();

/**
 * Gate:
 * - Must be authenticated
 * - Must have at least one of ORDERS_WRITE or REFUNDS_WRITE to access this router
 * - Per-endpoint permission checks remain (more granular)
 * - Audit all admin actions
 */
router.use(requireAuth());
router.use(
  requireAnyPermission(PERMISSIONS.ORDERS_WRITE, PERMISSIONS.REFUNDS_WRITE),
);
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function jsonRes(res, data, meta = undefined) {
  return sendOk(res, data, meta);
}

function jsonErr(req, res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error",
    {
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
      // Avoid leaking internal stack by default (keep debug in logs)
    },
  );
}

function safeNotFound(req, res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message, {
    requestId: getRequestId(req),
    path: req.originalUrl || req.url || "",
  });
}

function safeForbidden(req, res, code = "FORBIDDEN", message = "Forbidden") {
  return sendError(res, 403, code, message, {
    requestId: getRequestId(req),
    path: req.originalUrl || req.url || "",
  });
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  // keep short, stable, safe
  return raw ? raw.slice(0, 200) : "";
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeSearchRegex(input) {
  const safe = escapeRegex(
    String(input || "")
      .trim()
      .slice(0, 120),
  );
  return safe ? new RegExp(safe, "i") : null;
}

function looksLikeEmail(s) {
  const v = String(s || "").trim();
  // intentionally simple; avoids catastrophic regex
  return v.includes("@") && v.length <= 120;
}

/**
 * Safe date parsing: Zod already validated .datetime()
 * We still guard against invalid Date.
 */
function toDateOrUndefined(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  // eslint-disable-next-line no-restricted-globals
  return isNaN(d.getTime()) ? undefined : d;
}

/**
 * Pagination hard limits
 */
function parsePagination(q) {
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * Sorting allowlist:
 * - validated by Zod enum, but we still map special fields
 */
function buildSortOption(q) {
  let sortOption = { createdAt: -1 };

  if (!q.sortBy) return sortOption;

  const dir = q.sortDir === "asc" ? 1 : -1;

  if (q.sortBy === "totalMinor") {
    // keep backward compat if some docs use pricingMinor
    sortOption = { "pricingMinor.total": dir };
  } else {
    sortOption = { [q.sortBy]: dir };
  }

  return sortOption;
}

/* ============================
   Schemas
============================ */

/**
 * NOTE: validate() expects a structure like { query, params, body }.
 */
const listQuerySchema = z.object({
  query: z
    .object({
      status: z.string().max(200).optional(),
      paymentMethod: z.enum(["stripe", "cod"]).optional(),
      q: z.string().max(120).optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      isB2B: z.enum(["true", "false"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),

      // ✅ Allowlist-only sorting
      sortBy: z
        .enum([
          "createdAt",
          "updatedAt",
          "status",
          "paymentMethod",
          "totalMinor",
          "orderNumber",
        ])
        .optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),

      lang: z.string().optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      // dateFrom <= dateTo if both exist
      if (val.dateFrom && val.dateTo) {
        const df = new Date(val.dateFrom);
        const dt = new Date(val.dateTo);
        if (
          !Number.isNaN(df.getTime()) &&
          !Number.isNaN(dt.getTime()) &&
          df > dt
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "dateFrom must be <= dateTo",
            path: ["dateFrom"],
          });
        }
      }
    })
    .optional(),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
});

const statusUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      status: z.enum(ORDER_STATUSES),
    })
    .strict(),
});

const shippingUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      carrier: z.string().min(1).max(100).optional(),
      trackingNumber: z.string().min(1).max(100).optional(),
      shippedAt: z.string().datetime().optional(),
    })
    .strict(),
});

const cancelSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      reason: z.string().min(1).max(400),
      restock: z.boolean().optional(),
    })
    .strict(),
});

const refundSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      amount: z.number().min(0).optional(),
      reason: z
        .enum([
          "customer_cancel",
          "return",
          "out_of_stock",
          "fraud",
          "duplicate",
          "other",
        ])
        .optional(),
      note: z.string().max(400).optional(),
      items: z
        .array(
          z
            .object({
              productId: z.string().min(1),
              variantId: z.string().optional(),
              qty: z.number().int().min(1).max(999),
              amount: z.number().min(0).optional(),
            })
            .strict(),
        )
        .max(200)
        .optional(),
    })
    .strict(),
});

const resendEmailSchema = z.object({
  params: z.object({ id: z.string().min(1) }).strict(),
  body: z
    .object({
      type: z.enum(["confirmation", "shipping", "invoice"]).optional(),
    })
    .strict()
    .optional(),
});

/* ============================
   GET /api/admin/orders
   List orders (filters + pagination + safe sorting)
============================ */

router.get(
  "/",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(listQuerySchema),
  async (req, res) => {
    try {
      const q = req.validated?.query || {};
      const { page, limit, skip } = parsePagination(q);

      const filter = {};

      // status supports CSV
      if (q.status) {
        const statuses = String(q.status)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 30);

        if (statuses.length === 1) {
          filter.status = statuses[0];
        } else if (statuses.length > 1) {
          filter.status = { $in: statuses };
        }
      }

      if (q.paymentMethod) {
        filter.paymentMethod = q.paymentMethod;
      }

      const dateFrom = toDateOrUndefined(q.dateFrom);
      const dateTo = toDateOrUndefined(q.dateTo);

      if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom) filter.createdAt.$gte = dateFrom;
        if (dateTo) filter.createdAt.$lte = dateTo;
      }

      // B2B filter: find orders from business accounts
      if (q.isB2B === "true") {
        const b2bUserIds = await User.find({ accountType: "business" })
          .select("_id")
          .lean();
        if (b2bUserIds.length) {
          filter.userId = { $in: b2bUserIds.map((u) => u._id) };
        } else {
          filter.userId = null; // no B2B users = no results
        }
      } else if (q.isB2B === "false") {
        const b2bUserIds = await User.find({ accountType: "business" })
          .select("_id")
          .lean();
        if (b2bUserIds.length) {
          filter.userId = { $nin: b2bUserIds.map((u) => u._id) };
        }
      }

      // q: orderNumber / phone / (optionally) user email / _id
      const rawSearch = String(q.q || "")
        .trim()
        .slice(0, 120);
      const searchRegex = rawSearch ? makeSearchRegex(rawSearch) : null;

      if (searchRegex) {
        const or = [
          { orderNumber: searchRegex },
          { "shipping.phone": searchRegex },
          { "shipping.address.phone": searchRegex },
        ];

        // If looks like ObjectId, also match by _id
        if (isValidObjectId(rawSearch)) {
          or.push({ _id: rawSearch });
        }

        // If looks like email, also match by user email (bounded)
        if (looksLikeEmail(rawSearch)) {
          // IMPORTANT: keep this bounded to avoid heavy fan-out
          const userIds = await User.find({ email: searchRegex })
            .select("_id")
            .limit(50)
            .lean();

          if (userIds?.length) {
            or.push({ userId: { $in: userIds.map((u) => u._id) } });
          }
        }

        filter.$or = or;
      }

      const sortOption = buildSortOption(q);

      // Parallel fetch: items + total
      const [items, total] = await Promise.all([
        Order.find(filter)
          .sort(sortOption)
          .skip(skip)
          .limit(limit)
          .populate("userId", "name email")
          .lean(),
        Order.countDocuments(filter),
      ]);

      // Collect B2B user IDs for badge display
      const userIds = items.map((o) => o.userId?._id).filter(Boolean);
      const b2bUsers = userIds.length
        ? await User.find({ _id: { $in: userIds }, accountType: "business" })
            .select("_id")
            .lean()
        : [];
      const b2bSet = new Set(b2bUsers.map((u) => String(u._id)));

      // Normalize response shape for UI
      const mapped = (items || []).map((o) => ({
        ...mapOrder(o, { lang: req.lang }),
        user: o.userId
          ? {
              id: o.userId._id,
              name: o.userId.name || "",
              email: o.userId.email || "",
            }
          : null,
        isB2B: o.userId ? b2bSet.has(String(o.userId._id)) : false,
      }));

      return jsonRes(res, mapped, {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        sortBy: q.sortBy || "createdAt",
        sortDir: q.sortDir || "desc",
      });
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   GET /api/admin/orders/:id
============================ */

router.get(
  "/:id",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(idParamSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return safeNotFound(req, res, "NOT_FOUND", "Order not found");
      }

      const item = await Order.findById(id).populate(
        "userId",
        "name email phone",
      );
      if (!item) {
        return safeNotFound(req, res, "NOT_FOUND", "Order not found");
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
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   PATCH /api/admin/orders/:id/status
============================ */

router.patch(
  "/:id/status",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(statusUpdateSchema),
  async (req, res) => {
    try {
      const { order } = await updateOrderStatus(
        req.params.id,
        req.validated.body.status,
        {
          validateTransition: true,
          lang: req.lang,
        },
      );

      return jsonRes(res, mapOrder(order, { lang: req.lang }));
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   PATCH /api/admin/orders/:id/shipping
============================ */

router.patch(
  "/:id/shipping",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(shippingUpdateSchema),
  async (req, res) => {
    try {
      const order = await updateOrderShipping(
        req.params.id,
        req.validated.body,
      );
      return jsonRes(res, mapOrder(order, { lang: req.lang }));
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   POST /api/admin/orders/:id/cancel
============================ */

router.post(
  "/:id/cancel",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(cancelSchema),
  async (req, res) => {
    try {
      const { reason, restock } = req.validated.body;
      const { order, restocked } = await cancelOrder(req.params.id, {
        reason,
        restock,
      });

      return jsonRes(res, {
        ...mapOrder(order, { lang: req.lang }),
        restocked: Boolean(restocked),
      });
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   POST /api/admin/orders/:id/refund
   ✅ Requires REFUNDS_WRITE.
   - Admin can execute directly
   - Staff must create an approval request (workflow)
============================ */

router.post(
  "/:id/refund",
  requirePermission(PERMISSIONS.REFUNDS_WRITE),
  validate(refundSchema),
  async (req, res) => {
    try {
      // Staff: must go through approvals workflow
      if (req.user?.role !== "admin") {
        return safeForbidden(
          req,
          res,
          "REFUND_REQUIRES_APPROVAL",
          "Refunds require approval. Create a refund approval request at POST /admin/approvals.",
        );
      }

      const idemKey = pickIdempotencyKey(req);
      const { amount, reason, note, items } = req.validated.body;

      const result = await processRefund(req.params.id, {
        amount,
        reason,
        note,
        items,
        idempotencyKey: idemKey,
      });

      // Already refunded or idempotent replay
      if (result.alreadyRefunded) {
        return jsonRes(res, mapOrder(result.order, { lang: req.lang }));
      }

      // Manual action pending (e.g., provider / operational)
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
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   POST /api/admin/orders/:id/issue-invoice
============================ */

router.post(
  "/:id/issue-invoice",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(idParamSchema),
  async (req, res) => {
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
      // If invoice failed but we have an order, return it with error envelope + data
      if (e?.order) {
        return res.status(e.statusCode || 500).json({
          ok: false,
          success: false,
          error: {
            code: e.code || "INVOICE_FAILED",
            message: e.message || "Failed to issue invoice",
            requestId: getRequestId(req),
            path: req.originalUrl || req.url || "",
          },
          data: mapOrder(e.order, { lang: req.lang }),
        });
      }
      return jsonErr(req, res, e);
    }
  },
);

/* ============================
   POST /api/admin/orders/:id/resend-email
============================ */

router.post(
  "/:id/resend-email",
  requirePermission(PERMISSIONS.ORDERS_WRITE),
  validate(resendEmailSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return safeNotFound(req, res, "NOT_FOUND", "Order not found");
      }

      const order = await Order.findById(id)
        .populate("userId", "email lang")
        .lean();
      if (!order) {
        return safeNotFound(req, res, "NOT_FOUND", "Order not found");
      }

      const type = req.validated?.body?.type || "confirmation";

      // Currently only "confirmation" type is supported via our email service.
      // "shipping" and "invoice" types are stubs for future implementation.
      if (type !== "confirmation") {
        return jsonRes(res, {
          orderId: order._id,
          emailType: type,
          status: "not_implemented",
          message: `Email type "${type}" is not yet implemented.`,
        });
      }

      const to = String(order.userId?.email || "")
        .trim()
        .toLowerCase();
      if (!to) {
        return sendError(
          res,
          422,
          "NO_CUSTOMER_EMAIL",
          "No customer email address on this order",
          {
            requestId: getRequestId(req),
            path: req.originalUrl || req.url || "",
          },
        );
      }

      const lang = order.userId?.lang || "he";

      try {
        await sendOrderConfirmation(to, order, lang);

        // Update sent timestamp (admin resend always overwrites)
        await Order.updateOne(
          { _id: order._id },
          { $set: { confirmationEmailSentAt: new Date() } },
        );

        log.info(
          { orderId: String(order._id), adminId: String(req.user?._id || "") },
          "[admin.orders] resend confirmation email: success",
        );

        return jsonRes(res, {
          orderId: order._id,
          emailType: type,
          status: "sent",
        });
      } catch (mailErr) {
        log.error(
          {
            orderId: String(order._id),
            err: String(mailErr?.message || mailErr),
          },
          "[admin.orders] resend confirmation email: failed",
        );
        return sendError(
          res,
          502,
          "EMAIL_SEND_FAILED",
          "Failed to send email",
          {
            requestId: getRequestId(req),
            path: req.originalUrl || req.url || "",
          },
        );
      }
    } catch (e) {
      return jsonErr(req, res, e);
    }
  },
);

export default router;
