// src/routes/admin.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import {
  requireAuth,
  requirePermission,
  PERMISSIONS,
} from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { invalidateHomeCache } from "../utils/cache.js";

import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { Coupon } from "../models/Coupon.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { Offer } from "../models/Offer.js";

import {
  triggerRepairJob,
  getRepairJobStatus,
} from "../jobs/reservationsRepair.job.js";

const router = express.Router();

/* ============================
   Global Guards
============================ */
router.use(requireAuth());
router.use(auditAdmin());

/* ============================
   Small utilities
============================ */

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(String(id || ""));

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
    e.message || "Unexpected error",
  );
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message);
}

const asyncHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    return jsonErr(res, e);
  }
};

const requireObjectIdParam =
  (paramName, code = "INVALID_ID", message = "Invalid id") =>
  (req, _res, next) => {
    const id = String(req.params?.[paramName] || "");
    if (!isValidObjectId(id)) return next(makeErr(400, code, message));
    return next();
  };

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

function mapBilingualPatch(
  b,
  { nameMax = 160, addressMax = 220, notesMax = 800 } = {},
) {
  const patch = { ...b };

  // Trim strings
  for (const k of [
    "name",
    "nameHe",
    "nameAr",
    "address",
    "addressHe",
    "addressAr",
    "notes",
    "notesHe",
    "notesAr",
  ]) {
    if (typeof patch[k] === "string") patch[k] = patch[k].trim();
  }

  // Hard caps (defense-in-depth)
  if (patch.name && patch.name.length > nameMax)
    patch.name = patch.name.slice(0, nameMax);
  if (patch.nameHe && patch.nameHe.length > nameMax)
    patch.nameHe = patch.nameHe.slice(0, nameMax);
  if (patch.nameAr && patch.nameAr.length > nameMax)
    patch.nameAr = patch.nameAr.slice(0, nameMax);

  if (patch.address && patch.address.length > addressMax)
    patch.address = patch.address.slice(0, addressMax);
  if (patch.addressHe && patch.addressHe.length > addressMax)
    patch.addressHe = patch.addressHe.slice(0, addressMax);
  if (patch.addressAr && patch.addressAr.length > addressMax)
    patch.addressAr = patch.addressAr.slice(0, addressMax);

  if (patch.notes && patch.notes.length > notesMax)
    patch.notes = patch.notes.slice(0, notesMax);
  if (patch.notesHe && patch.notesHe.length > notesMax)
    patch.notesHe = patch.notesHe.slice(0, notesMax);
  if (patch.notesAr && patch.notesAr.length > notesMax)
    patch.notesAr = patch.notesAr.slice(0, notesMax);

  return patch;
}

function ensureStartBeforeEnd({ startAt, endAt }) {
  if (!startAt || !endAt) return;
  if (startAt.getTime() > endAt.getTime()) {
    throw makeErr(400, "INVALID_DATE_RANGE", "startAt must be before endAt");
  }
}

/* ============================
   Zod primitives
============================ */

const objectIdParamSchema = z.object({ id: z.string().min(1) }).strict();

// Reusable ObjectId string for refs (giftProductId, requiredProductId, etc.)
const objectIdString = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid ObjectId" });

// NOTE: coerce to accept "12" coming from forms safely; still strict allowlisting
const money = z.coerce.number().min(0);
const intMin1 = z.coerce.number().int().min(1);

const bilingualNameCreate = z
  .object({
    nameHe: z.string().min(2).max(160).optional(),
    nameAr: z.string().max(160).optional(),
    // legacy
    name: z.string().min(2).max(160).optional(),
  })
  .strict();

const bilingualNameUpdate = z
  .object({
    nameHe: z.string().min(2).max(160).optional(),
    nameAr: z.string().max(160).optional(),
    name: z.string().min(2).max(160).optional(),
  })
  .strict();

/* ============================
   Delivery Areas (SETTINGS_WRITE)
============================ */

const deliveryAreaCreateSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(120).optional(),
      nameAr: z.string().max(120).optional(),
      name: z.string().min(2).max(120).optional(), // legacy
      fee: money,
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const deliveryAreaUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      nameHe: z.string().min(2).max(120).optional(),
      nameAr: z.string().max(120).optional(),
      name: z.string().min(2).max(120).optional(),
      fee: money.optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const deliveryAreaDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/delivery-areas",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await DeliveryArea.find().sort({ createdAt: -1 }).lean();
    return sendOk(res, items);
  }),
);

router.post(
  "/delivery-areas",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(deliveryAreaCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const item = await DeliveryArea.create({
      nameHe: b.nameHe || b.name || "",
      nameAr: b.nameAr || "",
      name: b.name || b.nameHe || "",
      fee: b.fee,
      isActive: b.isActive ?? true,
    });

    return sendCreated(res, item);
  }),
);

router.put(
  "/delivery-areas/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(deliveryAreaUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid DeliveryArea id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const patch = mapBilingualPatch(req.validated.body, { nameMax: 120 });

    const item = await DeliveryArea.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });

    if (!item) return safeNotFound(res, "NOT_FOUND", "DeliveryArea not found");
    return sendOk(res, item);
  }),
);

router.delete(
  "/delivery-areas/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(deliveryAreaDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid DeliveryArea id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await DeliveryArea.findByIdAndDelete(id);

    if (!item) return safeNotFound(res, "NOT_FOUND", "DeliveryArea not found");
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Pickup Points (SETTINGS_WRITE)
============================ */

const pickupPointCreateSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      addressHe: z.string().min(2).max(220).optional(),
      addressAr: z.string().max(220).optional(),

      // legacy
      name: z.string().min(2).max(160).optional(),
      address: z.string().min(2).max(220).optional(),

      fee: money,
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const pickupPointUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      addressHe: z.string().min(2).max(220).optional(),
      addressAr: z.string().max(220).optional(),

      // legacy
      name: z.string().min(2).max(160).optional(),
      address: z.string().min(2).max(220).optional(),

      fee: money.optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const pickupPointDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/pickup-points",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await PickupPoint.find().sort({ createdAt: -1 }).lean();
    return sendOk(res, items);
  }),
);

router.post(
  "/pickup-points",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(pickupPointCreateSchema),
  asyncHandler(async (req, res) => {
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
  }),
);

router.put(
  "/pickup-points/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(pickupPointUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid PickupPoint id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const patch = mapBilingualPatch(req.validated.body, {
      nameMax: 160,
      addressMax: 220,
    });

    const item = await PickupPoint.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });

    if (!item) return safeNotFound(res, "NOT_FOUND", "PickupPoint not found");
    return sendOk(res, item);
  }),
);

router.delete(
  "/pickup-points/:id",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(pickupPointDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid PickupPoint id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await PickupPoint.findByIdAndDelete(id);

    if (!item) return safeNotFound(res, "NOT_FOUND", "PickupPoint not found");
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Store Pickup Config (SETTINGS_WRITE) - Singleton
============================ */

const storePickupUpdateSchema = z.object({
  body: z
    .object({
      isEnabled: z.boolean().optional(),
      fee: money.optional(),
      addressHe: z.string().max(220).optional(),
      addressAr: z.string().max(220).optional(),
      notesHe: z.string().max(800).optional(),
      notesAr: z.string().max(800).optional(),

      // legacy
      address: z.string().max(220).optional(),
      notes: z.string().max(800).optional(),
    })
    .strict(),
});

router.get(
  "/store-pickup",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  asyncHandler(async (_req, res) => {
    const cfg = await StorePickupConfig.findOne()
      .sort({ createdAt: -1 })
      .lean();
    return sendOk(
      res,
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
    );
  }),
);

router.put(
  "/store-pickup",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  validate(storePickupUpdateSchema),
  asyncHandler(async (req, res) => {
    const patch = mapBilingualPatch(req.validated.body, {
      addressMax: 220,
      notesMax: 800,
    });

    const cfg = await StorePickupConfig.findOne().sort({ createdAt: -1 });
    if (!cfg) {
      const created = await StorePickupConfig.create(patch);
      return sendOk(res, created);
    }

    Object.assign(cfg, patch);
    await cfg.save();

    return sendOk(res, cfg);
  }),
);

/* ============================
   Coupons (PROMOS_WRITE)
============================ */

const couponCreateSchema = z.object({
  body: z
    .object({
      code: z.string().min(2).max(40),
      type: z.enum(["percent", "fixed"]),
      value: money,
      minOrderTotal: money.optional(),
      maxDiscount: money.nullable().optional(),
      usageLimit: intMin1.nullable().optional(),
      usagePerUser: intMin1.nullable().optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const couponUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      code: z.string().min(2).max(40).optional(),
      type: z.enum(["percent", "fixed"]).optional(),
      value: money.optional(),
      minOrderTotal: money.optional(),
      maxDiscount: money.nullable().optional(),
      usageLimit: intMin1.nullable().optional(),
      usagePerUser: intMin1.nullable().optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const couponDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/coupons",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await Coupon.find().sort({ createdAt: -1 }).lean();
    return sendOk(res, items);
  }),
);

router.post(
  "/coupons",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(couponCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const startAt = b.startAt ? toDateOrNull(b.startAt) : null;
    const endAt = b.endAt ? toDateOrNull(b.endAt) : null;
    ensureStartBeforeEnd({ startAt, endAt });

    const item = await Coupon.create({
      code: normalizeCouponCode(b.code),
      type: b.type,
      value: b.value,
      minOrderTotal: b.minOrderTotal ?? 0,
      maxDiscount: b.maxDiscount ?? null,
      usageLimit: b.usageLimit ?? null,
      usagePerUser: b.usagePerUser ?? null,
      startAt,
      endAt,
      isActive: b.isActive ?? true,
    });

    return sendCreated(res, item);
  }),
);

const updateCouponHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const patch = { ...req.validated.body };

  if (patch.code) patch.code = normalizeCouponCode(patch.code);

  if ("startAt" in patch)
    patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
  if ("endAt" in patch)
    patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

  ensureStartBeforeEnd({
    startAt: patch.startAt ?? null,
    endAt: patch.endAt ?? null,
  });

  const item = await Coupon.findByIdAndUpdate(id, patch, {
    new: true,
    runValidators: true,
  });
  if (!item) return safeNotFound(res, "NOT_FOUND", "Coupon not found");

  return sendOk(res, item);
});

router.put(
  "/coupons/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(couponUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Coupon id"),
  updateCouponHandler,
);

router.patch(
  "/coupons/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(couponUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Coupon id"),
  updateCouponHandler,
);

router.delete(
  "/coupons/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(couponDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Coupon id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await Coupon.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Coupon not found");
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Campaigns (PROMOS_WRITE)
============================ */

const campaignCreateSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      type: z.enum(["percent", "fixed"]),
      value: money,
      appliesTo: z.enum(["all", "products", "categories"]).optional(),
      productIds: z.array(z.string().min(1)).optional(),
      categoryIds: z.array(z.string().min(1)).optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const campaignUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      type: z.enum(["percent", "fixed"]).optional(),
      value: money.optional(),
      appliesTo: z.enum(["all", "products", "categories"]).optional(),
      productIds: z.array(z.string().min(1)).optional(),
      categoryIds: z.array(z.string().min(1)).optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const campaignDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/campaigns",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await Campaign.find().sort({ createdAt: -1 }).lean();
    return sendOk(res, items);
  }),
);

router.post(
  "/campaigns",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(campaignCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const startAt = b.startAt ? toDateOrNull(b.startAt) : null;
    const endAt = b.endAt ? toDateOrNull(b.endAt) : null;
    ensureStartBeforeEnd({ startAt, endAt });

    const item = await Campaign.create({
      nameHe: b.nameHe || b.name || "",
      nameAr: b.nameAr || "",
      name: b.name || b.nameHe || "",
      type: b.type,
      value: b.value,
      appliesTo: b.appliesTo || "all",
      productIds: b.productIds || [],
      categoryIds: b.categoryIds || [],
      startAt,
      endAt,
      isActive: b.isActive ?? true,
    });

    return sendCreated(res, item);
  }),
);

const updateCampaignHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });

  if ("startAt" in patch)
    patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
  if ("endAt" in patch)
    patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

  ensureStartBeforeEnd({
    startAt: patch.startAt ?? null,
    endAt: patch.endAt ?? null,
  });

  const item = await Campaign.findByIdAndUpdate(id, patch, {
    new: true,
    runValidators: true,
  });
  if (!item) return safeNotFound(res, "NOT_FOUND", "Campaign not found");

  return sendOk(res, item);
});

router.put(
  "/campaigns/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(campaignUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Campaign id"),
  updateCampaignHandler,
);

router.patch(
  "/campaigns/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(campaignUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Campaign id"),
  updateCampaignHandler,
);

router.delete(
  "/campaigns/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(campaignDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Campaign id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await Campaign.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Campaign not found");
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Gifts (PROMOS_WRITE)
============================ */

const giftCreateSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(160),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      giftProductId: objectIdString,
      giftVariantId: objectIdString.nullable().optional(),
      qty: z.coerce.number().int().min(1).max(50).optional(),
      minOrderTotal: money.nullable().optional(),
      requiredProductId: objectIdString.nullable().optional(),
      requiredCategoryId: objectIdString.nullable().optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const giftUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      giftProductId: objectIdString.optional(),
      giftVariantId: objectIdString.nullable().optional(),
      qty: z.coerce.number().int().min(1).max(50).optional(),
      minOrderTotal: money.nullable().optional(),
      requiredProductId: objectIdString.nullable().optional(),
      requiredCategoryId: objectIdString.nullable().optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const giftDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/gifts",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await Gift.find().sort({ createdAt: -1 }).lean();
    return sendOk(res, items);
  }),
);

router.get(
  "/gifts/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Gift id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await Gift.findById(id).lean();
    if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");
    return sendOk(res, item);
  }),
);

router.post(
  "/gifts",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(giftCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const startAt = b.startAt ? toDateOrNull(b.startAt) : null;
    const endAt = b.endAt ? toDateOrNull(b.endAt) : null;
    ensureStartBeforeEnd({ startAt, endAt });

    const item = await Gift.create({
      nameHe: b.nameHe,
      nameAr: b.nameAr || "",
      name: b.name || b.nameHe || "",
      giftProductId: b.giftProductId,
      giftVariantId: b.giftVariantId ?? null,
      qty: b.qty ?? 1,
      minOrderTotal: b.minOrderTotal ?? null,
      requiredProductId: b.requiredProductId ?? null,
      requiredCategoryId: b.requiredCategoryId ?? null,
      startAt,
      endAt,
      isActive: b.isActive ?? true,
    });

    return sendCreated(res, item);
  }),
);

const updateGiftHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });

  if ("startAt" in patch)
    patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
  if ("endAt" in patch)
    patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

  ensureStartBeforeEnd({
    startAt: patch.startAt ?? null,
    endAt: patch.endAt ?? null,
  });

  const item = await Gift.findByIdAndUpdate(id, patch, {
    new: true,
    runValidators: true,
  });
  if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");

  return sendOk(res, item);
});

router.put(
  "/gifts/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(giftUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Gift id"),
  updateGiftHandler,
);

router.patch(
  "/gifts/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(giftUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Gift id"),
  updateGiftHandler,
);

router.delete(
  "/gifts/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(giftDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Gift id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await Gift.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Gift not found");
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Offers (PROMOS_WRITE)
============================ */

const offerCreateSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      type: z.enum([
        "PERCENT_OFF",
        "FIXED_OFF",
        "BUY_X_GET_Y",
        "FREE_SHIPPING",
      ]),
      value: money.optional(),
      minTotal: money.optional(),
      productIds: z.array(z.string().min(1)).optional(),
      categoryIds: z.array(z.string().min(1)).optional(),
      buyProductId: z.string().min(1).nullable().optional(),
      buyVariantId: z.string().min(1).nullable().optional(),
      buyQty: intMin1.optional(),
      getProductId: z.string().min(1).nullable().optional(),
      getVariantId: z.string().min(1).nullable().optional(),
      getQty: intMin1.optional(),
      maxDiscount: money.optional(),
      stackable: z.boolean().optional(),
      priority: z.coerce.number().int().min(0).optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const offerUpdateSchema = z.object({
  params: objectIdParamSchema,
  body: z
    .object({
      nameHe: z.string().min(2).max(160).optional(),
      nameAr: z.string().max(160).optional(),
      name: z.string().min(2).max(160).optional(),
      type: z
        .enum(["PERCENT_OFF", "FIXED_OFF", "BUY_X_GET_Y", "FREE_SHIPPING"])
        .optional(),
      value: money.optional(),
      minTotal: money.optional(),
      productIds: z.array(z.string().min(1)).optional(),
      categoryIds: z.array(z.string().min(1)).optional(),
      buyProductId: z.string().min(1).nullable().optional(),
      buyVariantId: z.string().min(1).nullable().optional(),
      buyQty: intMin1.optional(),
      getProductId: z.string().min(1).nullable().optional(),
      getVariantId: z.string().min(1).nullable().optional(),
      getQty: intMin1.optional(),
      maxDiscount: money.optional(),
      stackable: z.boolean().optional(),
      priority: z.coerce.number().int().min(0).optional(),
      startAt: z.string().datetime().nullable().optional(),
      endAt: z.string().datetime().nullable().optional(),
      isActive: z.boolean().optional(),
    })
    .strict(),
});

const offerDeleteSchema = z.object({
  params: objectIdParamSchema,
});

router.get(
  "/offers",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  asyncHandler(async (_req, res) => {
    const items = await Offer.find()
      .sort({ priority: 1, createdAt: -1 })
      .lean();
    return sendOk(res, items);
  }),
);

router.post(
  "/offers",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(offerCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const startAt = b.startAt ? toDateOrNull(b.startAt) : null;
    const endAt = b.endAt ? toDateOrNull(b.endAt) : null;
    ensureStartBeforeEnd({ startAt, endAt });

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
      buyVariantId: b.buyVariantId ?? null,
      buyQty: b.buyQty ?? 1,
      getProductId: b.getProductId ?? null,
      getVariantId: b.getVariantId ?? null,
      getQty: b.getQty ?? 1,
      maxDiscount: b.maxDiscount ?? 0,
      stackable: b.stackable ?? true,
      priority: b.priority ?? 100,
      startAt,
      endAt,
      isActive: b.isActive ?? true,
    });

    invalidateHomeCache().catch(() => {});
    return sendCreated(res, item);
  }),
);

const updateOfferHandler = asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const patch = mapBilingualPatch(req.validated.body, { nameMax: 160 });

  if ("startAt" in patch)
    patch.startAt = patch.startAt ? toDateOrNull(patch.startAt) : null;
  if ("endAt" in patch)
    patch.endAt = patch.endAt ? toDateOrNull(patch.endAt) : null;

  ensureStartBeforeEnd({
    startAt: patch.startAt ?? null,
    endAt: patch.endAt ?? null,
  });

  const item = await Offer.findByIdAndUpdate(id, patch, {
    new: true,
    runValidators: true,
  });
  if (!item) return safeNotFound(res, "NOT_FOUND", "Offer not found");

  invalidateHomeCache().catch(() => {});
  return sendOk(res, item);
});

router.put(
  "/offers/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(offerUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Offer id"),
  updateOfferHandler,
);

router.patch(
  "/offers/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(offerUpdateSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Offer id"),
  updateOfferHandler,
);

router.delete(
  "/offers/:id",
  requirePermission(PERMISSIONS.PROMOS_WRITE),
  validate(offerDeleteSchema),
  requireObjectIdParam("id", "INVALID_ID", "Invalid Offer id"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const item = await Offer.findByIdAndDelete(id);
    if (!item) return safeNotFound(res, "NOT_FOUND", "Offer not found");
    invalidateHomeCache().catch(() => {});
    return sendOk(res, { deleted: true });
  }),
);

/* ============================
   Stock Reservation Repair (SETTINGS_WRITE)
============================ */

router.get(
  "/reservations/repair/status",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  asyncHandler(async (_req, res) => {
    const status = getRepairJobStatus();
    return sendOk(res, status);
  }),
);

router.post(
  "/reservations/repair/trigger",
  requirePermission(PERMISSIONS.SETTINGS_WRITE),
  asyncHandler(async (_req, res) => {
    const result = await triggerRepairJob();
    return sendOk(res, result);
  }),
);

export default router;
