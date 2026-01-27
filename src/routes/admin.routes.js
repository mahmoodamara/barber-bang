// src/routes/admin.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { requireAuth, requireRole, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";

import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { Coupon } from "../models/Coupon.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { Offer } from "../models/Offer.js";
import { Order } from "../models/Order.js";

import { mapOrder } from "../utils/mapOrder.js";
import {
  updateOrderStatus,
  updateOrderInvoice,
  processRefund,
  ORDER_STATUSES,
} from "../services/admin-orders.service.js";
import { getRequestId } from "../middleware/error.js";
import {
  triggerRepairJob,
  getRepairJobStatus,
} from "../jobs/reservationsRepair.job.js";

const router = express.Router();

router.use(requireAuth());
// Legacy admin routes - require admin role
// For permission-based access, use dedicated routes:
// - /api/v1/admin/orders (ORDERS_WRITE)
// - /api/v1/admin/products (PRODUCTS_WRITE)
// router.use(requireRole("admin", "staff")); // Removed: requirePermission handles role checks
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
   Delivery Areas (requires SETTINGS_WRITE)
============================ */

router.get("/delivery-areas", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const items = await DeliveryArea.find().sort({ createdAt: -1 });
    return sendOk(res, items);
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

router.post("/delivery-areas", requirePermission(PERMISSIONS.SETTINGS_WRITE), validate(deliveryAreaCreateSchema), async (req, res) => {
  try {
    const b = req.validated.body;
    const item = await DeliveryArea.create({
      nameHe: b.nameHe || b.name || "",
      nameAr: b.nameAr || "",
      name: b.name || b.nameHe || "",
      fee: b.fee,
      isActive: b.isActive ?? true,
    });
    return sendCreated(res, item);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/delivery-areas/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
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
      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/delivery-areas/:id", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid DeliveryArea id");

    const item = await DeliveryArea.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "DeliveryArea not found");
    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Pickup Points (requires SETTINGS_WRITE)
============================ */

router.get("/pickup-points", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const items = await PickupPoint.find().sort({ createdAt: -1 });
    return sendOk(res, items);
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

router.post("/pickup-points", requirePermission(PERMISSIONS.SETTINGS_WRITE), validate(pickupPointCreateSchema), async (req, res) => {
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

    return sendCreated(res, item);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/pickup-points/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
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
      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/pickup-points/:id", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid PickupPoint id");

    const item = await PickupPoint.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "PickupPoint not found");
    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Store Pickup Config (requires SETTINGS_WRITE)
============================ */

router.get("/store-pickup", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const cfg = await StorePickupConfig.findOne().sort({ createdAt: -1 });
    return sendOk(res, cfg || {
      isEnabled: true,
      fee: 0,
      addressHe: "",
      addressAr: "",
      notesHe: "",
      notesAr: "",
      // legacy
      address: "",
      notes: "",
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.put(
  "/store-pickup",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
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
        return sendOk(res, created);
      }

      Object.assign(cfg, patch);
      await cfg.save();

      return sendOk(res, cfg);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   Coupons (requires PROMOS_WRITE)
============================ */

router.get("/coupons", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const items = await Coupon.find().sort({ createdAt: -1 });
    return sendOk(res, items);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/coupons",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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
      return sendCreated(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/coupons/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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

      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/coupons/:id", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Coupon id");

    const item = await Coupon.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Coupon not found");

    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Campaigns (requires PROMOS_WRITE)
============================ */

router.get("/campaigns", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const items = await Campaign.find().sort({ createdAt: -1 });
    return sendOk(res, items);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/campaigns",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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
      return sendCreated(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/campaigns/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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

      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/campaigns/:id", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Campaign id");

    const item = await Campaign.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Campaign not found");

    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Gifts (requires PROMOS_WRITE)
============================ */

router.get("/gifts", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const items = await Gift.find().sort({ createdAt: -1 });
    return sendOk(res, items);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/gifts",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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
      return sendCreated(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/gifts/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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

      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/gifts/:id", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Gift id");

    const item = await Gift.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");

    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Offers (requires PROMOS_WRITE)
============================ */

router.get("/offers", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const items = await Offer.find().sort({ priority: 1, createdAt: -1 });
    return sendOk(res, items);
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.post(
  "/offers",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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
      return sendCreated(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.put(
  "/offers/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
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

      return sendOk(res, item);
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

router.delete("/offers/:id", requirePermission(PERMISSIONS.PROMOS_WRITE), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) throw makeErr(400, "INVALID_ID", "Invalid Offer id");

    const item = await Offer.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Offer not found");

    return sendOk(res, { deleted: true });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   Orders (Admin View) - Legacy endpoints
   REMOVED: Use /api/v1/admin/orders routes (admin.orders.routes.js)
============================ */


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

/* ============================
   Stock Reservation Repair (requires SETTINGS_WRITE)
============================ */

/**
 * GET /api/v1/admin/reservations/repair/status
 * Get the status of the background repair job
 */
router.get("/reservations/repair/status", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const status = getRepairJobStatus();
    return res.json({ ok: true, data: status });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/**
 * POST /api/v1/admin/reservations/repair/trigger
 * Manually trigger a repair job run
 * Returns the repair run statistics
 */
router.post("/reservations/repair/trigger", requirePermission(PERMISSIONS.SETTINGS_WRITE), async (req, res) => {
  try {
    const result = await triggerRepairJob();
    return res.json({ ok: true, data: result });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
