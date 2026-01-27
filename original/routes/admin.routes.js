// src/routes/admin.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requireRole } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";

import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { Coupon } from "../models/Coupon.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { Offer } from "../models/Offer.js";
import { Order } from "../models/Order.js";

import { createStripeRefund } from "../services/stripe.service.js";
import { createInvoiceForOrder, resolveInvoiceProvider } from "../services/invoice.service.js";

const router = express.Router();

router.use(requireAuth());
router.use(requireRole("admin"));
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

function jsonErr(res, e) {
  return res.status(e.statusCode || 500).json({
    ok: false,
    error: {
      code: e.code || "INTERNAL_ERROR",
      message: e.message || "Unexpected error",
    },
  });
}

async function issueInvoiceBestEffort(order) {
  if (!order || !order._id) return;
  if (order?.invoice?.status === "issued") return;

  try {
    const invoice = await createInvoiceForOrder(order);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": invoice.provider,
          "invoice.docId": invoice.docId || "",
          "invoice.number": invoice.number || "",
          "invoice.url": invoice.url || "",
          "invoice.issuedAt": invoice.issuedAt || null,
          "invoice.status": invoice.status || "pending",
          "invoice.error": invoice.error || "",
        },
      }
    );
  } catch (e) {
    const provider = resolveInvoiceProvider(order);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "invoice.provider": provider,
          "invoice.docId": String(order._id),
          "invoice.number": "",
          "invoice.url": "",
          "invoice.issuedAt": null,
          "invoice.status": "failed",
          "invoice.error": String(e?.message || "Invoice failed"),
        },
      }
    );
  }
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return res.status(404).json({ ok: false, error: { code, message } });
}

function pickIdempotencyKey(req) {
  const raw = String(req.headers["idempotency-key"] || "").trim();
  return raw ? raw.slice(0, 200) : "";
}

function normalizeCouponCode(code) {
  const v = String(code || "").trim();
  return v ? v.toUpperCase() : "";
}

function toDateOrNull(v) {
  if (v === null) return null;
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function mapBilingualPatch(b, { nameMax = 160, addressMax = 220, notesMax = 800 } = {}) {
  const patch = { ...b };

  // Trim strings
  for (const k of ["name", "nameHe", "nameAr", "address", "addressHe", "addressAr", "notes", "notesHe", "notesAr"]) {
    if (typeof patch[k] === "string") patch[k] = patch[k].trim();
  }

  // Hard caps (defense-in-depth)
  if (patch.name && patch.name.length > nameMax) patch.name = patch.name.slice(0, nameMax);
  if (patch.nameHe && patch.nameHe.length > nameMax) patch.nameHe = patch.nameHe.slice(0, nameMax);
  if (patch.nameAr && patch.nameAr.length > nameMax) patch.nameAr = patch.nameAr.slice(0, nameMax);

  if (patch.address && patch.address.length > addressMax) patch.address = patch.address.slice(0, addressMax);
  if (patch.addressHe && patch.addressHe.length > addressMax) patch.addressHe = patch.addressHe.slice(0, addressMax);
  if (patch.addressAr && patch.addressAr.length > addressMax) patch.addressAr = patch.addressAr.slice(0, addressMax);

  if (patch.notes && patch.notes.length > notesMax) patch.notes = patch.notes.slice(0, notesMax);
  if (patch.notesHe && patch.notesHe.length > notesMax) patch.notesHe = patch.notesHe.slice(0, notesMax);
  if (patch.notesAr && patch.notesAr.length > notesMax) patch.notesAr = patch.notesAr.slice(0, notesMax);

  return patch;
}

/* ============================
   Delivery Areas
============================ */

router.get("/delivery-areas", async (req, res) => {
  try {
    const items = await DeliveryArea.find().sort({ createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

const deliveryAreaCreateSchema = z.object({
  body: z.object({
    nameHe: z.string().min(2).max(120).optional(),
    nameAr: z.string().max(120).optional(),
    name: z.string().min(2).max(120).optional(),
    fee: z.number().min(0),
    isActive: z.boolean().optional(),
  }),
});

router.post("/delivery-areas", validate(deliveryAreaCreateSchema), async (req, res) => {
  try {
    const b = req.validated.body;
    const item = await DeliveryArea.create({
      nameHe: b.nameHe || b.name || "",
      nameAr: b.nameAr || "",
      name: b.name || b.nameHe || "",
      fee: b.fee,
      isActive: b.isActive ?? true,
    });
    return res.status(201).json({ ok: true, data: item });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/delivery-areas/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        nameHe: z.string().min(2).max(120).optional(),
        nameAr: z.string().max(120).optional(),
        name: z.string().min(2).max(120).optional(),
        fee: z.number().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid DeliveryArea id");

      const patch = mapBilingualPatch(req.validated.body, { nameMax: 120 });
      const item = await DeliveryArea.findByIdAndUpdate(id, patch, {
        new: true,
        runValidators: true,
      });

      if (!item) return safeNotFound(res, "NOT_FOUND", "DeliveryArea not found");
      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/delivery-areas/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid DeliveryArea id");

    const item = await DeliveryArea.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "DeliveryArea not found");
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Pickup Points
============================ */

router.get("/pickup-points", async (req, res) => {
  try {
    const items = await PickupPoint.find().sort({ createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

const pickupPointCreateSchema = z.object({
  body: z.object({
    nameHe: z.string().min(2).max(160).optional(),
    nameAr: z.string().max(160).optional(),
    addressHe: z.string().min(2).max(220).optional(),
    addressAr: z.string().max(220).optional(),

    // legacy
    name: z.string().min(2).max(160).optional(),
    address: z.string().min(2).max(220).optional(),

    fee: z.number().min(0),
    isActive: z.boolean().optional(),
  }),
});

router.post("/pickup-points", validate(pickupPointCreateSchema), async (req, res) => {
  try {
    const b = req.validated.body;

    const item = await PickupPoint.create({
      nameHe: b.nameHe || b.name || "",
      nameAr: b.nameAr || "",
      addressHe: b.addressHe || b.address || "",
      addressAr: b.addressAr || "",

      // legacy
      name: b.name || b.nameHe || "",
      address: b.address || b.addressHe || "",

      fee: b.fee,
      isActive: b.isActive ?? true,
    });

    return res.status(201).json({ ok: true, data: item });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/pickup-points/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        addressHe: z.string().min(2).max(220).optional(),
        addressAr: z.string().max(220).optional(),

        // legacy
        name: z.string().min(2).max(160).optional(),
        address: z.string().min(2).max(220).optional(),

        fee: z.number().min(0).optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid PickupPoint id");

      const patch = mapBilingualPatch(req.validated.body, { nameMax: 160, addressMax: 220 });
      const item = await PickupPoint.findByIdAndUpdate(id, patch, {
        new: true,
        runValidators: true,
      });

      if (!item) return safeNotFound(res, "NOT_FOUND", "PickupPoint not found");
      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/pickup-points/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid PickupPoint id");

    const item = await PickupPoint.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "PickupPoint not found");
    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Store Pickup Config (single doc)
============================ */

router.get("/store-pickup", async (req, res) => {
  try {
    const cfg = await StorePickupConfig.findOne().sort({ createdAt: -1 });
    return res.json({
      ok: true,
      data:
        cfg || {
          isEnabled: true,
          fee: 0,
          addressHe: "",
          addressAr: "",
          notesHe: "",
          notesAr: "",
          // legacy
          address: "",
          notes: "",
        },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/store-pickup",
  validate(
    z.object({
      body: z.object({
        isEnabled: z.boolean().optional(),
        fee: z.number().min(0).optional(),
        addressHe: z.string().max(220).optional(),
        addressAr: z.string().max(220).optional(),
        notesHe: z.string().max(800).optional(),
        notesAr: z.string().max(800).optional(),

        // legacy
        address: z.string().max(220).optional(),
        notes: z.string().max(800).optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const patch = mapBilingualPatch(req.validated.body, { addressMax: 220, notesMax: 800 });

      const cfg = await StorePickupConfig.findOne().sort({ createdAt: -1 });
      if (!cfg) {
        const created = await StorePickupConfig.create(patch);
        return res.json({ ok: true, data: created });
      }

      Object.assign(cfg, patch);
      await cfg.save();

      return res.json({ ok: true, data: cfg });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   Coupons
============================ */

router.get("/coupons", async (req, res) => {
  try {
    const items = await Coupon.find().sort({ createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/coupons",
  validate(
    z.object({
      body: z.object({
        code: z.string().min(2).max(40),
        type: z.enum(["percent", "fixed"]),
        value: z.number().min(0),
        minOrderTotal: z.number().min(0).optional(),
        maxDiscount: z.number().min(0).nullable().optional(),
        usageLimit: z.number().min(1).nullable().optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const item = await Coupon.create({
        code: normalizeCouponCode(b.code),
        type: b.type,
        value: b.value,
        minOrderTotal: b.minOrderTotal || 0,
        maxDiscount: b.maxDiscount ?? null,
        usageLimit: b.usageLimit ?? null,
        startAt: b.startAt ? toDateOrNull(b.startAt) : null,
        endAt: b.endAt ? toDateOrNull(b.endAt) : null,
        isActive: b.isActive ?? true,
      });
      return res.status(201).json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/coupons/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        code: z.string().min(2).max(40).optional(),
        type: z.enum(["percent", "fixed"]).optional(),
        value: z.number().min(0).optional(),
        minOrderTotal: z.number().min(0).optional(),
        maxDiscount: z.number().min(0).nullable().optional(),
        usageLimit: z.number().min(1).nullable().optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Coupon id");

      const patch = { ...req.validated.body };
      if (patch.code) patch.code = normalizeCouponCode(patch.code);
      if ("startAt" in patch) patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
      if ("endAt" in patch) patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

      const item = await Coupon.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
      if (!item) return safeNotFound(res, "NOT_FOUND", "Coupon not found");

      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/coupons/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Coupon id");

    const item = await Coupon.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Coupon not found");

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Campaigns
============================ */

router.get("/campaigns", async (req, res) => {
  try {
    const items = await Campaign.find().sort({ createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/campaigns",
  validate(
    z.object({
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        type: z.enum(["percent", "fixed"]),
        value: z.number().min(0),
        appliesTo: z.enum(["all", "products", "categories"]).optional(),
        productIds: z.array(z.string().min(1)).optional(),
        categoryIds: z.array(z.string().min(1)).optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const item = await Campaign.create({
        nameHe: b.nameHe || b.name || "",
        nameAr: b.nameAr || "",
        name: b.name || b.nameHe || "",
        type: b.type,
        value: b.value,
        appliesTo: b.appliesTo || "all",
        productIds: b.productIds || [],
        categoryIds: b.categoryIds || [],
        startAt: b.startAt ? toDateOrNull(b.startAt) : null,
        endAt: b.endAt ? toDateOrNull(b.endAt) : null,
        isActive: b.isActive ?? true,
      });
      return res.status(201).json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/campaigns/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        type: z.enum(["percent", "fixed"]).optional(),
        value: z.number().min(0).optional(),
        appliesTo: z.enum(["all", "products", "categories"]).optional(),
        productIds: z.array(z.string().min(1)).optional(),
        categoryIds: z.array(z.string().min(1)).optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Campaign id");

      const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });
      if ("startAt" in patch) patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
      if ("endAt" in patch) patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

      const item = await Campaign.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
      if (!item) return safeNotFound(res, "NOT_FOUND", "Campaign not found");

      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/campaigns/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Campaign id");

    const item = await Campaign.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Campaign not found");

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Gifts
============================ */

router.get("/gifts", async (req, res) => {
  try {
    const items = await Gift.find().sort({ createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/gifts",
  validate(
    z.object({
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        giftProductId: z.string().min(1),
        minOrderTotal: z.number().min(0).nullable().optional(),
        requiredProductId: z.string().min(1).nullable().optional(),
        requiredCategoryId: z.string().min(1).nullable().optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const item = await Gift.create({
        nameHe: b.nameHe || b.name || "",
        nameAr: b.nameAr || "",
        name: b.name || b.nameHe || "",
        giftProductId: b.giftProductId,
        minOrderTotal: b.minOrderTotal ?? null,
        requiredProductId: b.requiredProductId ?? null,
        requiredCategoryId: b.requiredCategoryId ?? null,
        startAt: b.startAt ? toDateOrNull(b.startAt) : null,
        endAt: b.endAt ? toDateOrNull(b.endAt) : null,
        isActive: b.isActive ?? true,
      });
      return res.status(201).json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/gifts/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        giftProductId: z.string().min(1).optional(),
        minOrderTotal: z.number().min(0).nullable().optional(),
        requiredProductId: z.string().min(1).nullable().optional(),
        requiredCategoryId: z.string().min(1).nullable().optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Gift id");

      const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });
      if ("startAt" in patch) patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
      if ("endAt" in patch) patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

      const item = await Gift.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
      if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");

      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/gifts/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Gift id");

    const item = await Gift.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Offers
============================ */

router.get("/offers", async (req, res) => {
  try {
    const items = await Offer.find().sort({ priority: 1, createdAt: -1 });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/offers",
  validate(
    z.object({
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        type: z.enum(["PERCENT_OFF", "FIXED_OFF", "BUY_X_GET_Y", "FREE_SHIPPING"]),
        value: z.number().min(0).optional(),
        minTotal: z.number().min(0).optional(),
        productIds: z.array(z.string().min(1)).optional(),
        categoryIds: z.array(z.string().min(1)).optional(),
        buyProductId: z.string().min(1).nullable().optional(),
        buyQty: z.number().int().min(1).optional(),
        getProductId: z.string().min(1).nullable().optional(),
        getQty: z.number().int().min(1).optional(),
        maxDiscount: z.number().min(0).optional(),
        stackable: z.boolean().optional(),
        priority: z.number().int().min(0).optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const item = await Offer.create({
        nameHe: b.nameHe || b.name || "",
        nameAr: b.nameAr || "",
        name: b.name || b.nameHe || "",
        type: b.type,
        value: b.value ?? 0,
        minTotal: b.minTotal ?? 0,
        productIds: b.productIds || [],
        categoryIds: b.categoryIds || [],
        buyProductId: b.buyProductId ?? null,
        buyQty: b.buyQty ?? 1,
        getProductId: b.getProductId ?? null,
        getQty: b.getQty ?? 1,
        maxDiscount: b.maxDiscount ?? 0,
        stackable: b.stackable ?? true,
        priority: b.priority ?? 100,
        startAt: b.startAt ? toDateOrNull(b.startAt) : null,
        endAt: b.endAt ? toDateOrNull(b.endAt) : null,
        isActive: b.isActive ?? true,
      });
      return res.status(201).json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/offers/:id",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        nameHe: z.string().min(2).max(160).optional(),
        nameAr: z.string().max(160).optional(),
        name: z.string().min(2).max(160).optional(),
        type: z.enum(["PERCENT_OFF", "FIXED_OFF", "BUY_X_GET_Y", "FREE_SHIPPING"]).optional(),
        value: z.number().min(0).optional(),
        minTotal: z.number().min(0).optional(),
        productIds: z.array(z.string().min(1)).optional(),
        categoryIds: z.array(z.string().min(1)).optional(),
        buyProductId: z.string().min(1).nullable().optional(),
        buyQty: z.number().int().min(1).optional(),
        getProductId: z.string().min(1).nullable().optional(),
        getQty: z.number().int().min(1).optional(),
        maxDiscount: z.number().min(0).optional(),
        stackable: z.boolean().optional(),
        priority: z.number().int().min(0).optional(),
        startAt: z.string().datetime().nullable().optional(),
        endAt: z.string().datetime().nullable().optional(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Offer id");

      const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });
      if ("startAt" in patch) patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
      if ("endAt" in patch) patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

      const item = await Offer.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
      if (!item) return safeNotFound(res, "NOT_FOUND", "Offer not found");

      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/offers/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Offer id");

    const item = await Offer.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Offer not found");

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Orders (Admin View)
============================ */

router.get(
  "/orders",
  validate(
    z.object({
      query: z
        .object({
          limit: z.string().regex(/^\d+$/).optional(),
        })
        .optional(),
    })
  ),
  async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.validated.query?.limit || 200)));
      const items = await Order.find().sort({ createdAt: -1 }).limit(limit);
      return res.json({ ok: true, data: items });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/**
 * PUT /api/v1/admin/orders/:id/status
 * Extend allowed statuses to match new model
 */
router.put(
  "/orders/:id/status",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        status: z.enum([
          "pending_payment",
          "pending_cod",
          "cod_pending_approval",
          "paid",
          "payment_received",
          "confirmed",
          "stock_confirmed",
          "shipped",
          "delivered",
          "cancelled",

          "refund_pending",
          "partially_refunded",
          "refunded",
          "return_requested",
        ]),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Order id");

      const existing = await Order.findById(id);
      if (!existing) return safeNotFound(res, "NOT_FOUND", "Order not found");

      const nextStatus = req.validated.body.status;
      const item = await Order.findByIdAndUpdate(
        id,
        { $set: { status: nextStatus } },
        { new: true, runValidators: true }
      );

      if (!item) return safeNotFound(res, "NOT_FOUND", "Order not found");

      const codPendingStatuses = new Set(["pending_cod", "cod_pending_approval"]);
      const codApprovalStatuses = new Set([
        "confirmed",
        "stock_confirmed",
        "shipped",
        "delivered",
        "paid",
      ]);
      const shouldIssueInvoice =
        existing.paymentMethod === "cod" &&
        codPendingStatuses.has(String(existing.status || "")) &&
        codApprovalStatuses.has(String(nextStatus || ""));

      if (shouldIssueInvoice) {
        await issueInvoiceBestEffort(item);
      }

      return res.json({ ok: true, data: item });
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/**
 * POST /api/v1/admin/orders/:id/refund
 * Admin-triggered refund (full or partial) - Stripe only
 *
 * Body:
 * - amount (optional): if omitted => full refund (pricing.total)
 * - reason: customer_cancel | return | out_of_stock | fraud | duplicate | other
 * - note (optional)
 *
 * Idempotency:
 * - use "Idempotency-Key" header to prevent duplicates
 */
router.post(
  "/orders/:id/refund",
  validate(
    z.object({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({
        amount: z.number().min(0).optional(), // ILS major
        reason: z.enum(["customer_cancel", "return", "out_of_stock", "fraud", "duplicate", "other"]).optional(),
        note: z.string().max(400).optional(),
      }),
    })
  ),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Order id");

      const idemKey = pickIdempotencyKey(req);
      const { amount, reason, note } = req.validated.body;

      const order = await Order.findById(id);
      if (!order) return safeNotFound(res, "NOT_FOUND", "Order not found");

      if (order.paymentMethod !== "stripe") {
        throw makeErr(400, "REFUND_NOT_SUPPORTED", "Refunds are only supported for Stripe orders");
      }

      const paymentIntentId = String(order?.stripe?.paymentIntentId || "");
      if (!paymentIntentId) {
        throw makeErr(400, "MISSING_PAYMENT_INTENT", "Order has no paymentIntentId");
      }

      // Already refunded
      if (order?.refund?.status === "succeeded" || order.status === "refunded") {
        return res.json({ ok: true, data: order });
      }

      // Amount checks
      const orderTotal = Number(order?.pricing?.total ?? order?.total ?? 0);
      const refundAmount = typeof amount === "number" ? amount : orderTotal;

      if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        throw makeErr(400, "INVALID_REFUND_AMOUNT", "Refund amount must be > 0");
      }
      if (orderTotal > 0 && refundAmount > orderTotal) {
        throw makeErr(400, "AMOUNT_EXCEEDS_TOTAL", "Refund amount exceeds order total");
      }

      // Idempotency guard (best-effort)
      if (idemKey && String(order?.idempotency?.refundKey || "") === idemKey) {
        const fresh = await Order.findById(order._id);
        return res.json({ ok: true, data: fresh || order });
      }

      // Mark pending first
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            status: "refund_pending",
            "refund.status": "pending",
            "refund.reason": reason || "other",
            "refund.requestedAt": new Date(),
            ...(idemKey ? { "idempotency.refundKey": idemKey } : {}),
            ...(note ? { internalNote: String(note) } : {}),
          },
        }
      );

      // Execute refund
      try {
        const refund = await createStripeRefund({
          paymentIntentId,
          amountMajor: refundAmount,
          reason: reason || "other",
          idempotencyKey: idemKey || `refund:admin:${String(order._id)}:${paymentIntentId}:${refundAmount}`,
        });

        const isPartial = refundAmount > 0 && orderTotal > 0 && refundAmount < orderTotal;

        const updated = await Order.findByIdAndUpdate(
          order._id,
          {
            $set: {
              status: isPartial ? "partially_refunded" : "refunded",
              "refund.status": "succeeded",
              "refund.amount": refundAmount,
              "refund.currency": "ils",
              "refund.stripeRefundId": String(refund?.id || ""),
              "refund.refundedAt": new Date(),
              ...(note ? { internalNote: String(note) } : {}),
            },
          },
          { new: true }
        );

        return res.json({ ok: true, data: updated });
      } catch (rfErr) {
        const updated = await Order.findByIdAndUpdate(
          order._id,
          {
            $set: {
              status: "refund_pending",
              "refund.status": "failed",
              "refund.failureMessage": String(rfErr?.message || "Refund failed").slice(0, 800),
              ...(note ? { internalNote: String(note) } : {}),
            },
          },
          { new: true }
        );

        return res.status(202).json({
          ok: true,
          data: updated,
          warning: "REFUND_PENDING_MANUAL_ACTION",
        });
      }
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   IMPORTANT: Returns moved out
============================ */
/**
 * ✅ Returns are handled in:
 *   src/routes/admin.returns.routes.js
 * mounted at: /api/v1/admin/returns
 *
 * Do NOT re-add returns endpoints here to avoid duplication/conflicts.
 */

export default router;
