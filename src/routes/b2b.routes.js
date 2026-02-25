import express from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { validate } from "../middleware/validate.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { RFQ } from "../models/RFQ.js";
import { Product } from "../models/Product.js";
import { OrderTemplate } from "../models/OrderTemplate.js";
import { SampleRequest } from "../models/SampleRequest.js";
import { RecurringOrder } from "../models/RecurringOrder.js";

const router = express.Router();

/**
 * POST /api/v1/b2b/apply
 * Submit a B2B wholesale account application.
 * Requires authentication.
 */
const applySchema = z.object({
  body: z.object({
    businessName: z.string().min(2).max(200),
    businessId: z.string().min(1).max(50).optional(),
    taxId: z.string().max(50).optional(),
    phone: z.string().min(5).max(20).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

router.post(
  "/apply",
  requireAuth(),
  validate(applySchema),
  async (req, res) => {
    try {
      const { businessName, businessId, taxId } =
        req.validated?.body ?? req.body;

      const user = await User.findById(req.user._id);
      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error: { code: "NOT_FOUND", message: "User not found" },
          });
      }

      if (user.b2bApproved) {
        return res.json({ ok: true, data: { status: "already_approved" } });
      }

      user.accountType = "business";
      user.businessName = businessName;
      if (businessId) user.businessId = businessId;
      if (taxId) user.taxId = taxId;
      user.b2bAppliedAt = new Date();

      await user.save();

      return res.json({ ok: true, data: { status: "pending_review" } });
    } catch (e) {
      return res
        .status(500)
        .json({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: e.message },
        });
    }
  },
);

/**
 * GET /api/v1/b2b/status
 * Check B2B application status.
 */
router.get("/status", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      "accountType businessName wholesaleTier b2bApproved b2bAppliedAt b2bApprovedAt",
    );
    if (!user) {
      return res
        .status(404)
        .json({
          ok: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
    }

    return res.json({
      ok: true,
      data: {
        accountType: user.accountType,
        businessName: user.businessName,
        wholesaleTier: user.wholesaleTier,
        b2bApproved: user.b2bApproved,
        b2bAppliedAt: user.b2bAppliedAt,
        b2bApprovedAt: user.b2bApprovedAt,
      },
    });
  } catch (e) {
    return res
      .status(500)
      .json({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: e.message },
      });
  }
});

/* ============================
   RFQ — Request for Quote
============================ */

const rfqCreateSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          qty: z.number().int().min(1).max(99999),
          note: z.string().max(500).optional(),
        }),
      )
      .min(1)
      .max(50),
    customerNote: z.string().max(2000).optional(),
  }),
});

/**
 * POST /api/v1/b2b/rfq
 * Submit an RFQ (B2B users only).
 */
router.post(
  "/rfq",
  requireAuth(),
  validate(rfqCreateSchema),
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id).select("b2bApproved accountType").lean();
      if (!user?.b2bApproved) {
        return res.status(403).json({
          ok: false,
          error: { code: "NOT_B2B", message: "B2B account required" },
        });
      }

      const { items, customerNote } = req.validated?.body ?? req.body;

      const productIds = items.map((i) => i.productId);
      const products = await Product.find({ _id: { $in: productIds } })
        .select("_id titleHe titleAr title")
        .lean();
      const productMap = new Map(products.map((p) => [String(p._id), p]));

      const rfqItems = items.map((item) => {
        const product = productMap.get(item.productId);
        return {
          productId: item.productId,
          productTitle: product?.titleHe || product?.title || product?.titleAr || "",
          qty: item.qty,
          note: item.note || "",
        };
      });

      const rfq = new RFQ({
        userId: req.user._id,
        items: rfqItems,
        customerNote: customerNote || "",
      });

      await rfq.save();

      return res.status(201).json({ ok: true, data: rfq.toObject() });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
    }
  },
);

/**
 * GET /api/v1/b2b/rfq
 * List user's RFQs.
 */
router.get("/rfq", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({
        ok: false,
        error: { code: "NOT_B2B", message: "B2B account required" },
      });
    }

    const rfqs = await RFQ.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.json({ ok: true, data: rfqs });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/**
 * GET /api/v1/b2b/rfq/:id
 * Get a single RFQ.
 */
router.get("/rfq/:id", requireAuth(), async (req, res) => {
  try {
    const rfq = await RFQ.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!rfq) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "RFQ not found" },
      });
    }

    return res.json({ ok: true, data: rfq });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Order Templates
============================ */

const templateCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    items: z
      .array(z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(9999),
        variantId: z.string().optional(),
      }))
      .min(1)
      .max(100),
  }),
});

router.post("/templates", requireAuth(), validate(templateCreateSchema), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { name, items } = req.validated?.body ?? req.body;
    const existing = await OrderTemplate.countDocuments({ userId: req.user._id });
    if (existing >= 20) {
      return res.status(400).json({ ok: false, error: { code: "LIMIT_REACHED", message: "Max 20 templates" } });
    }

    const template = await OrderTemplate.create({ userId: req.user._id, name, items });
    return res.status(201).json({ ok: true, data: template.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.get("/templates", requireAuth(), async (req, res) => {
  try {
    const templates = await OrderTemplate.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ ok: true, data: templates });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.delete("/templates/:id", requireAuth(), async (req, res) => {
  try {
    const result = await OrderTemplate.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template not found" } });
    }
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/**
 * POST /api/v1/b2b/templates/:id/add-to-cart
 * Add all items from a saved template to cart.
 */
router.post("/templates/:id/add-to-cart", requireAuth(), async (req, res) => {
  try {
    const template = await OrderTemplate.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!template) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Template not found" } });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "User not found" } });
    }

    let addedCount = 0;
    for (const item of template.items) {
      const product = await Product.findById(item.productId).select("_id isActive stock").lean();
      if (!product || !product.isActive || product.stock <= 0) continue;

      const existingIdx = (user.cart || []).findIndex(
        (c) => String(c.productId) === String(item.productId) && String(c.variantId || "") === String(item.variantId || ""),
      );

      if (existingIdx >= 0) {
        user.cart[existingIdx].qty = item.qty;
      } else {
        user.cart.push({
          productId: item.productId,
          qty: item.qty,
          variantId: item.variantId || undefined,
        });
      }
      addedCount++;
    }

    await user.save();
    return res.json({ ok: true, data: { addedCount, cartSize: user.cart.length } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/**
 * POST /api/v1/b2b/templates/from-order/:orderId
 * Create a template from an existing order.
 */
router.post("/templates/from-order/:orderId", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { default: Order } = await import("../models/Order.js");
    const order = await Order.findOne({ _id: req.params.orderId, userId: req.user._id }).lean();
    if (!order) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Order not found" } });
    }

    const items = (order.items || []).map((i) => ({
      productId: i.productId,
      qty: i.qty || 1,
      variantId: i.variantId || undefined,
    }));

    const name = req.body?.name || `Order #${order.orderNumber || String(order._id).slice(-6)}`;

    const template = await OrderTemplate.create({ userId: req.user._id, name, items });
    return res.status(201).json({ ok: true, data: template.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Sample Requests
============================ */

const sampleCreateSchema = z.object({
  body: z.object({
    items: z
      .array(z.object({ productId: z.string().min(1) }))
      .min(1)
      .max(5),
    note: z.string().max(1000).optional(),
  }),
});

router.post("/samples", requireAuth(), validate(sampleCreateSchema), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { items, note } = req.validated?.body ?? req.body;

    // Check for recent requests (max 1 per 7 days)
    const recent = await SampleRequest.findOne({
      userId: req.user._id,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }).lean();
    if (recent) {
      return res.status(429).json({ ok: false, error: { code: "TOO_FREQUENT", message: "Max 1 sample request per week" } });
    }

    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } })
      .select("_id titleHe titleAr title")
      .lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const sampleItems = items.map((item) => {
      const product = productMap.get(item.productId);
      return {
        productId: item.productId,
        productTitle: product?.titleHe || product?.title || product?.titleAr || "",
      };
    });

    const sample = await SampleRequest.create({
      userId: req.user._id,
      items: sampleItems,
      note: note || "",
    });

    return res.status(201).json({ ok: true, data: sample.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.get("/samples", requireAuth(), async (req, res) => {
  try {
    const samples = await SampleRequest.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json({ ok: true, data: samples });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   Recurring Orders
============================ */

function computeNextRun(frequency) {
  const now = new Date();
  const ms = {
    weekly: 7 * 24 * 60 * 60 * 1000,
    biweekly: 14 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
    bimonthly: 60 * 24 * 60 * 60 * 1000,
    quarterly: 90 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() + (ms[frequency] || ms.monthly));
}

const recurringCreateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    items: z
      .array(z.object({
        productId: z.string().min(1),
        qty: z.number().int().min(1).max(9999),
        variantId: z.string().optional(),
      }))
      .min(1)
      .max(100),
    frequency: z.enum(["weekly", "biweekly", "monthly", "bimonthly", "quarterly"]),
    shippingMode: z.enum(["DELIVERY", "PICKUP_POINT", "STORE_PICKUP"]).optional(),
    deliveryAreaId: z.string().optional(),
    pickupPointId: z.string().optional(),
  }),
});

router.post("/recurring", requireAuth(), validate(recurringCreateSchema), async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("b2bApproved").lean();
    if (!user?.b2bApproved) {
      return res.status(403).json({ ok: false, error: { code: "NOT_B2B", message: "B2B account required" } });
    }

    const { name, items, frequency, shippingMode, deliveryAreaId, pickupPointId } = req.validated?.body ?? req.body;

    const existing = await RecurringOrder.countDocuments({ userId: req.user._id, isActive: true });
    if (existing >= 10) {
      return res.status(400).json({ ok: false, error: { code: "LIMIT_REACHED", message: "Max 10 active recurring orders" } });
    }

    const recurring = await RecurringOrder.create({
      userId: req.user._id,
      name,
      items,
      frequency,
      nextRunAt: computeNextRun(frequency),
      shippingMode: shippingMode || "DELIVERY",
      deliveryAreaId: deliveryAreaId || "",
      pickupPointId: pickupPointId || "",
    });

    return res.status(201).json({ ok: true, data: recurring.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.get("/recurring", requireAuth(), async (req, res) => {
  try {
    const items = await RecurringOrder.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ ok: true, data: items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.patch("/recurring/:id", requireAuth(), async (req, res) => {
  try {
    const recurring = await RecurringOrder.findOne({ _id: req.params.id, userId: req.user._id });
    if (!recurring) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
    }

    if (req.body.isActive !== undefined) recurring.isActive = Boolean(req.body.isActive);
    if (req.body.frequency) {
      recurring.frequency = req.body.frequency;
      recurring.nextRunAt = computeNextRun(req.body.frequency);
    }

    await recurring.save();
    return res.json({ ok: true, data: recurring.toObject() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

router.delete("/recurring/:id", requireAuth(), async (req, res) => {
  try {
    const result = await RecurringOrder.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
    }
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e.message } });
  }
});

/* ============================
   GET /api/v1/b2b/my-custom-pricing
   Returns the authenticated user's custom price list
============================ */
router.get("/my-custom-pricing", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("customPricing b2bApproved")
      .lean();

    if (!user?.b2bApproved) {
      return res.json({ customPricing: [] });
    }

    const priceMap = {};
    for (const cp of user.customPricing || []) {
      priceMap[String(cp.productId)] = cp.price;
    }

    return res.json({ customPricing: priceMap });
  } catch (e) {
    return res.status(500).json({ error: "INTERNAL", message: e.message });
  }
});

export default router;
