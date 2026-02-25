import express from "express";
import { z } from "zod";
import { RFQ } from "../models/RFQ.js";
import { SampleRequest } from "../models/SampleRequest.js";
import { requireAuth, requireRole, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = express.Router();

router.use(requireAuth());
router.use(requireRole("admin"));

function isValidObjectId(id) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || ""));
}

const listSchema = z.object({
  query: z
    .object({
      status: z.string().max(100).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

/**
 * GET /api/admin/rfq
 */
router.get("/", validate(listSchema), async (req, res) => {
  try {
    const q = req.validated?.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    if (q.status && q.status !== "all") {
      filter.status = q.status;
    }

    const [items, total] = await Promise.all([
      RFQ.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email businessName wholesaleTier")
        .lean(),
      RFQ.countDocuments(filter),
    ]);

    return res.json({
      ok: true,
      data: items,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/**
 * GET /api/admin/rfq/:id
 */
router.get("/:id", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "RFQ not found" } });
    }

    const rfq = await RFQ.findById(req.params.id)
      .populate("userId", "name email businessName wholesaleTier")
      .lean();

    if (!rfq) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "RFQ not found" } });
    }

    return res.json({ ok: true, data: rfq });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

const quoteSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    quotedItems: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1),
          unitPrice: z.number().min(0),
        }),
      )
      .min(1)
      .max(50),
    adminNote: z.string().max(2000).optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  }),
});

/**
 * PATCH /api/admin/rfq/:id/quote
 * Provide a quote for an RFQ.
 */
router.patch("/:id/quote", validate(quoteSchema), async (req, res) => {
  try {
    const rfq = await RFQ.findById(req.params.id);
    if (!rfq) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "RFQ not found" } });
    }

    const { quotedItems, adminNote, expiresInDays } = req.validated?.body ?? req.body;

    rfq.status = "quoted";
    rfq.quotedItems = quotedItems;
    rfq.quotedTotal = quotedItems.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
    rfq.quotedAt = new Date();
    rfq.quotedBy = req.user._id;
    if (adminNote) rfq.adminNote = adminNote;
    if (expiresInDays) {
      rfq.expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    }

    await rfq.save();

    return res.json({ ok: true, data: rfq.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

const statusSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    status: z.enum(["reviewing", "rejected", "expired"]),
    adminNote: z.string().max(2000).optional(),
  }),
});

/**
 * PATCH /api/admin/rfq/:id/status
 * Update RFQ status.
 */
router.patch("/:id/status", validate(statusSchema), async (req, res) => {
  try {
    const rfq = await RFQ.findById(req.params.id);
    if (!rfq) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "RFQ not found" } });
    }

    const { status, adminNote } = req.validated?.body ?? req.body;
    rfq.status = status;
    if (adminNote) rfq.adminNote = adminNote;

    await rfq.save();

    return res.json({ ok: true, data: rfq.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Admin Sample Requests
============================ */

router.get("/samples", async (req, res) => {
  try {
    const q = req.query || {};
    const filter = {};
    if (q.status && q.status !== "all") filter.status = q.status;

    const items = await SampleRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("userId", "name email businessName")
      .lean();

    return res.json({ ok: true, data: items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

const sampleStatusSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    status: z.enum(["approved", "shipped", "rejected"]),
    adminNote: z.string().max(1000).optional(),
    trackingNumber: z.string().max(100).optional(),
  }),
});

router.patch("/samples/:id", validate(sampleStatusSchema), async (req, res) => {
  try {
    const sample = await SampleRequest.findById(req.params.id);
    if (!sample) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Sample request not found" } });
    }

    const { status, adminNote, trackingNumber } = req.validated?.body ?? req.body;
    sample.status = status;
    if (adminNote) sample.adminNote = adminNote;
    if (trackingNumber) sample.trackingNumber = trackingNumber;
    if (status === "shipped") sample.shippedAt = new Date();

    await sample.save();
    return res.json({ ok: true, data: sample.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

export default router;
