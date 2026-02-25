// src/routes/admin.products.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { ProductAttribute } from "../models/ProductAttribute.js";
import { Category } from "../models/Category.js";
import { generateCatalogQaReport } from "../services/catalogQa.service.js";
import {
  toMinorSafe,
  normalizeKey,
  buildLegacyAttributes,
  normalizeAttributesInput,
  mergeAttributesWithLegacy,
  legacyAttributesObject,
  isSaleActiveByPrice,
} from "../utils/productHelpers.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { t } from "../utils/i18n.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { invalidateHomeCache, invalidateRankingCache } from "../utils/cache.js";

const router = express.Router();
const DEFAULT_BATCH_DISCLAIMER =
  "Actual product packaging and materials may contain more and/or different information. Do not solely rely on information presented here.";

/** Invalidate home and ranking caches after product mutations (fire-and-forget) */
function invalidateProductCaches() {
  invalidateHomeCache().catch(() => {});
  invalidateRankingCache().catch(() => {});
}

// Auth + Role: admin or staff with PRODUCTS_WRITE permission
router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.PRODUCTS_WRITE));
router.use(auditAdmin());
router.use((req, _res, next) => {
  if (req?.body && typeof req.body === "object") {
    delete req.body.isFeatured;
    delete req.body.isBestSeller;
  }
  next();
});

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

/**
 * Validate that a Category exists by ID.
 * Only performs DB lookup when categoryId is provided.
 * @param {string|undefined} categoryId - The category ID to validate
 * @throws {Error} If categoryId is provided but category doesn't exist
 */
async function validateCategoryExists(categoryId) {
  if (!categoryId) return; // Skip if not provided - no extra DB read
  const exists = await Category.exists({ _id: categoryId });
  if (!exists) {
    throw makeErr(400, "CATEGORY_NOT_FOUND", "Category not found");
  }
}

async function applyCatalogValidationToVariants(variants) {
  const allAttrs = [];
  for (const v of variants || []) {
    if (!v) continue;
    v.attributes = mergeAttributesWithLegacy(v);
    for (const a of v.attributes) allAttrs.push(a);
  }

  const keys = [...new Set(allAttrs.map((a) => a.key))];
  if (!keys.length) return variants;

  const defs = await ProductAttribute.find({ key: { $in: keys } }).lean();
  const byKey = new Map(defs.map((d) => [String(d.key), d]));

  for (const v of variants || []) {
    const cleaned = [];
    const seen = new Set();
    for (const a of v.attributes || []) {
      const def = byKey.get(a.key);
      if (!def || !def.isActive) {
        throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Invalid attribute key: ${a.key}`);
      }

      if (seen.has(a.key)) {
        throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Duplicate attribute key: ${a.key}`);
      }
      seen.add(a.key);

      const type = String(def.type || "");
      if (a.type && String(a.type) !== type) {
        throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} type mismatch`);
      }

      if (type === "text") {
        if (typeof a.value !== "string") {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} must be text`);
        }
        const val = a.value.trim();
        if (!val) {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} cannot be empty`);
        }
        cleaned.push({ key: a.key, type, value: val, valueKey: "", unit: "" });
        continue;
      }

      if (type === "number") {
        const n = Number(a.value);
        if (!Number.isFinite(n)) {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} must be a number`);
        }
        let unit = String(a.unit || "").trim();
        const defUnit = String(def.unit || "").trim();
        if (defUnit && unit && defUnit !== unit) {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} unit must be ${defUnit}`);
        }
        if (!unit && defUnit) unit = defUnit;
        cleaned.push({ key: a.key, type, value: n, valueKey: "", unit });
        continue;
      }

      if (type === "enum") {
        const valueKey = normalizeKey(a.valueKey);
        if (!valueKey) {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} requires valueKey`);
        }
        const opt = (def.options || []).find(
          (o) => String(o?.valueKey || "") === valueKey && o?.isActive
        );
        if (!opt) {
          throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} valueKey is invalid`);
        }
        cleaned.push({ key: a.key, type, value: null, valueKey, unit: "" });
        continue;
      }

      throw makeErr(400, "INVALID_VARIANT_ATTRIBUTE", `Attribute ${a.key} has invalid type`);
    }
    v.attributes = cleaned;
  }

  return variants;
}

function mapVariant(v) {
  const attributesList = mergeAttributesWithLegacy(v);
  const legacyObj = legacyAttributesObject(attributesList);
  return {
    id: v?._id,
    _id: v?._id,
    variantKey: v?.variantKey || "",
    sku: v?.sku || "",
    barcode: v?.barcode || "",
    priceOverride: v?.priceOverride ?? null,
    stock: Number(v?.stock ?? 0),
    attributes: attributesList.map((a) => ({
      key: a.key,
      type: a.type,
      value: a.value ?? null,
      valueKey: a.valueKey || "",
      unit: a.unit || "",
    })),
    volumeMl: legacyObj.volumeMl,
    weightG: legacyObj.weightG,
    packCount: legacyObj.packCount,
    scent: legacyObj.scent,
    holdLevel: legacyObj.holdLevel,
    finishType: legacyObj.finishType,
    skinType: legacyObj.skinType,
  };
}

function mapProductImage(img) {
  return {
    id: img?._id ? String(img._id) : null,
    assetId: img?.assetId ? String(img.assetId) : null,
    url: img?.url || "",
    secureUrl: img?.secureUrl || "",
    altHe: img?.altHe || "",
    altAr: img?.altAr || "",
    isPrimary: Boolean(img?.isPrimary),
    sortOrder: Number(img?.sortOrder || 0),
  };
}

function mapProductAdmin(p, lang) {
  const obj = typeof p.toObject === "function" ? p.toObject() : { ...p };
  const now = new Date();
  const onSale = isSaleActiveByPrice(obj, now);

  // Map images array
  const images = Array.isArray(obj.images) ? obj.images.map(mapProductImage) : [];

  // Determine main image (primary from images[] or fallback to imageUrl)
  const primaryImage = images.find((img) => img.isPrimary);
  const mainImage = primaryImage
    ? primaryImage.secureUrl || primaryImage.url
    : obj.imageUrl || "";

  return {
    id: obj._id,
    _id: obj._id,
    titleHe: obj.titleHe || obj.title || "",
    titleAr: obj.titleAr || "",
    title: t(obj, "title", lang),
    descriptionHe: obj.descriptionHe || obj.description || "",
    descriptionAr: obj.descriptionAr || "",
    description: t(obj, "description", lang),
    // Never send empty string for slug (Radix Select.Item disallows value="")
    slug: (obj.slug && String(obj.slug).trim()) ? obj.slug : (obj._id ? String(obj._id) : "__pending__"),
    price: Number(obj.price || 0),
    priceMinor: obj.priceMinor || 0,
    stock: Number(obj.stock || 0),
    categoryId: obj.categoryId || null,
    imageUrl: obj.imageUrl || "",
    mainImage,
    images,
    isActive: Boolean(obj.isActive),
    isDeleted: Boolean(obj.isDeleted),
    brand: obj.brand || "",
    sku: obj.sku || "",
    barcode: obj.barcode || "",
    sizeLabel: obj.sizeLabel || "",
    unit: obj.unit ?? null,
    netQuantity: obj.netQuantity ?? null,
    tags: Array.isArray(obj.tags) ? obj.tags : [],
    ingredients: obj.ingredients || "",
    usage: obj.usage || "",
    warnings: obj.warnings || "",
    manufacturerName: obj.manufacturerName || "",
    importerName: obj.importerName || "",
    countryOfOrigin: obj.countryOfOrigin || "",
    warrantyInfo: obj.warrantyInfo || "",
    catalogStatus: obj.catalogStatus || "HOLD",
    confidenceGrade: obj.confidenceGrade || "D",
    verification: {
      isModelVerified: Boolean(obj.verification?.isModelVerified),
      isCategoryVerified: Boolean(obj.verification?.isCategoryVerified),
      verifiedSourcesCount: Number(obj.verification?.verifiedSourcesCount || 0),
      lastVerifiedAt: obj.verification?.lastVerifiedAt || null,
      notes: obj.verification?.notes || "",
      notesHe: obj.verification?.notesHe || "",
      notesAr: obj.verification?.notesAr || "",
      hasCriticalMismatch: Boolean(obj.verification?.hasCriticalMismatch),
    },
    identity: {
      internalSku: obj.identity?.internalSku || "",
      model: obj.identity?.model || "",
      productLine: obj.identity?.productLine || "",
    },
    classification: {
      categoryPrimary: obj.classification?.categoryPrimary || "",
      categorySecondary: obj.classification?.categorySecondary || "",
    },
    specs: {
      batteryMah: obj.specs?.batteryMah ?? null,
      chargingTimeMin: obj.specs?.chargingTimeMin ?? null,
      runtimeMin: obj.specs?.runtimeMin ?? null,
      voltageV: obj.specs?.voltageV ?? null,
      powerW: obj.specs?.powerW ?? null,
      motorSpeedRpmMin: obj.specs?.motorSpeedRpmMin ?? null,
      motorSpeedRpmMax: obj.specs?.motorSpeedRpmMax ?? null,
      speedModes: obj.specs?.speedModes ?? null,
      waterproofRating: obj.specs?.waterproofRating || "",
      displayType: obj.specs?.displayType || "",
      bladeMaterial: obj.specs?.bladeMaterial || "",
      foilMaterial: obj.specs?.foilMaterial || "",
      chargingType: obj.specs?.chargingType || "",
      usageMode: obj.specs?.usageMode || "",
    },
    packageIncludes: Array.isArray(obj.packageIncludes) ? obj.packageIncludes : [],
    packageIncludesHe: Array.isArray(obj.packageIncludesHe) ? obj.packageIncludesHe : [],
    packageIncludesAr: Array.isArray(obj.packageIncludesAr) ? obj.packageIncludesAr : [],
    compatibility: {
      replacementHeadCompatibleWith: Array.isArray(
        obj.compatibility?.replacementHeadCompatibleWith
      )
        ? obj.compatibility.replacementHeadCompatibleWith
        : [],
    },
    publishContent: {
      seoKeywords: Array.isArray(obj.publishContent?.seoKeywords)
        ? obj.publishContent.seoKeywords
        : [],
      bulletsHe: Array.isArray(obj.publishContent?.bulletsHe) ? obj.publishContent.bulletsHe : [],
      bulletsAr: Array.isArray(obj.publishContent?.bulletsAr) ? obj.publishContent.bulletsAr : [],
      shortDescHe: obj.publishContent?.shortDescHe || "",
      shortDescAr: obj.publishContent?.shortDescAr || "",
      batchVariationDisclaimer:
        obj.publishContent?.batchVariationDisclaimer || DEFAULT_BATCH_DISCLAIMER,
    },
    variants: Array.isArray(obj.variants) ? obj.variants.map(mapVariant) : [],
    sale: onSale
      ? {
        salePrice: Number(obj.salePrice || 0),
        discountPercent: obj.discountPercent ?? null,
        saleStartAt: obj.saleStartAt || null,
        saleEndAt: obj.saleEndAt || null,
      }
      : null,
    salePrice: obj.salePrice ?? null,
    salePriceMinor: obj.salePriceMinor ?? null,
    discountPercent: obj.discountPercent ?? null,
    saleStartAt: obj.saleStartAt || null,
    saleEndAt: obj.saleEndAt || null,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/* ============================
   Allowed fields whitelist
============================ */

const ALLOWED_PATCH_FIELDS = new Set([
  "titleHe",
  "titleAr",
  "descriptionHe",
  "descriptionAr",
  "title",
  "description",
  "price",
  "stock",
  "categoryId",
  "imageUrl",
  "isActive",
  "salePrice",
  "discountPercent",
  "saleStartAt",
  "saleEndAt",
  "brand",
  "sku",
  "barcode",
  "sizeLabel",
  "unit",
  "netQuantity",
  "tags",
  "ingredients",
  "usage",
  "warnings",
  "manufacturerName",
  "importerName",
  "countryOfOrigin",
  "warrantyInfo",
  "catalogStatus",
  "confidenceGrade",
  "verification",
  "identity",
  "classification",
  "specs",
  "packageIncludes",
  "packageIncludesHe",
  "packageIncludesAr",
  "compatibility",
  "publishContent",
  "wholesalePricing",
]);

// Computed fields that must NEVER be updated directly
const FORBIDDEN_PATCH_FIELDS = new Set([
  "variantKey",
  "priceMinor",
  "salePriceMinor",
  "priceOverrideMinor",
  "stats",
  "isDeleted",
  "deletedAt",
  "images",
  "variants",
  "_id",
  "createdAt",
  "updatedAt",
]);

function filterPatchFields(body) {
  const result = {};
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_PATCH_FIELDS.has(key)) {
      continue; // Skip forbidden fields silently
    }
    if (ALLOWED_PATCH_FIELDS.has(key)) {
      result[key] = body[key];
    }
  }
  return result;
}

/* ============================
   Schemas
============================ */

const variantSchema = z.object({
  _id: z.string().min(1).optional(),
  sku: z.string().max(80).optional(),
  barcode: z.string().max(80).optional(),
  priceOverride: z.number().min(0).nullable().optional(),
  stock: z.number().int().min(0),
  attributes: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        type: z.enum(["text", "number", "enum"]),
        value: z.any().optional(),
        valueKey: z.string().max(80).optional(),
        unit: z.string().max(20).optional(),
      })
    )
    .optional(),
  volumeMl: z.number().min(0).nullable().optional(),
  weightG: z.number().min(0).nullable().optional(),
  packCount: z.number().min(0).nullable().optional(),
  scent: z.string().max(80).optional(),
  holdLevel: z.string().max(80).optional(),
  finishType: z.string().max(80).optional(),
  skinType: z.string().max(80).optional(),
});

const catalogStatusSchema = z.enum(["READY", "READY_WITH_EDITS", "HOLD"]);
const confidenceGradeSchema = z.enum(["A", "B", "C", "D"]);

const verificationSchema = z
  .object({
    isModelVerified: z.boolean().optional(),
    isCategoryVerified: z.boolean().optional(),
    verifiedSourcesCount: z.number().int().min(0).optional(),
    lastVerifiedAt: z.string().datetime().nullable().optional(),
    notes: z.string().max(4000).optional(),
    notesHe: z.string().max(4000).optional(),
    notesAr: z.string().max(4000).optional(),
    hasCriticalMismatch: z.boolean().optional(),
  })
  .optional();

const identitySchema = z
  .object({
    internalSku: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    productLine: z.string().max(120).optional(),
  })
  .optional();

const classificationSchema = z
  .object({
    categoryPrimary: z.string().max(120).optional(),
    categorySecondary: z.string().max(120).optional(),
  })
  .optional();

const specsSchema = z
  .object({
    batteryMah: z.number().min(0).nullable().optional(),
    chargingTimeMin: z.number().min(0).nullable().optional(),
    runtimeMin: z.number().min(0).nullable().optional(),
    voltageV: z.number().min(0).nullable().optional(),
    powerW: z.number().min(0).nullable().optional(),
    motorSpeedRpmMin: z.number().min(0).nullable().optional(),
    motorSpeedRpmMax: z.number().min(0).nullable().optional(),
    speedModes: z.number().min(0).nullable().optional(),
    waterproofRating: z.string().max(40).optional(),
    displayType: z.string().max(40).optional(),
    bladeMaterial: z.string().max(120).optional(),
    foilMaterial: z.string().max(120).optional(),
    chargingType: z.string().max(40).optional(),
    usageMode: z.string().max(40).optional(),
  })
  .optional();

const compatibilitySchema = z
  .object({
    replacementHeadCompatibleWith: z.array(z.string().max(120)).max(50).optional(),
  })
  .optional();

const publishContentSchema = z
  .object({
    seoKeywords: z.array(z.string().max(80)).max(50).optional(),
    bulletsHe: z.array(z.string().max(200)).max(50).optional(),
    bulletsAr: z.array(z.string().max(200)).max(50).optional(),
    shortDescHe: z.string().max(1000).optional(),
    shortDescAr: z.string().max(1000).optional(),
    batchVariationDisclaimer: z.string().max(1000).optional(),
  })
  .optional();

const wholesalePricingSchema = z
  .array(
    z.object({
      tier: z.enum(["bronze", "silver", "gold"]),
      price: z.number().min(0),
      minQty: z.number().int().min(1).optional().default(1),
    })
  )
  .max(3)
  .optional();

const listQuerySchema = z.object({
  query: z
    .object({
      search: z.string().max(120).optional(),
      categoryId: z.string().optional(),
      brand: z.string().max(120).optional(),
      isActive: z.enum(["true", "false"]).optional(),
      isDeleted: z.enum(["true", "false"]).optional(),
      hasVariants: z.enum(["true", "false"]).optional(),
      catalogStatus: catalogStatusSchema.optional(),
      confidenceGrade: confidenceGradeSchema.optional(),
      unverifiedOnly: z.enum(["true", "false"]).optional(),
      categoryMismatchOnly: z.enum(["true", "false"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
      sortBy: z.enum(["createdAt", "updatedAt", "price", "stock", "title"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    })
    .optional(),
});

const createBodySchema = z
  .object({
    titleHe: z.string().min(2).max(160).optional(),
    titleAr: z.string().max(160).optional(),
    descriptionHe: z.string().max(4000).optional(),
    descriptionAr: z.string().max(4000).optional(),
    title: z.string().min(2).max(160).optional(),
    description: z.string().max(4000).optional(),
    price: z.number().min(0),
    stock: z.number().int().min(0),
    categoryId: z.string().min(1),
    imageUrl: z.string().optional(),
    isActive: z.boolean().optional(),
    salePrice: z.number().min(0).nullable().optional(),
    discountPercent: z.number().min(0).max(100).nullable().optional(),
    saleStartAt: z.string().datetime().nullable().optional(),
    saleEndAt: z.string().datetime().nullable().optional(),
    brand: z.string().max(120).optional(),
    sku: z.string().max(80).optional(),
    barcode: z.string().max(80).optional(),
    sizeLabel: z.string().max(80).optional(),
    unit: z.enum(["ml", "g", "pcs", "set"]).nullable().optional(),
    netQuantity: z.number().min(0).nullable().optional(),
    tags: z.array(z.string().max(40)).optional(),
    ingredients: z.string().max(4000).optional(),
    usage: z.string().max(4000).optional(),
    warnings: z.string().max(4000).optional(),
    manufacturerName: z.string().max(160).optional(),
    importerName: z.string().max(160).optional(),
    countryOfOrigin: z.string().max(120).optional(),
    warrantyInfo: z.string().max(400).optional(),
    catalogStatus: catalogStatusSchema.optional(),
    confidenceGrade: confidenceGradeSchema.optional(),
    verification: verificationSchema,
    identity: identitySchema,
    classification: classificationSchema,
    specs: specsSchema,
    packageIncludes: z.array(z.string().max(200)).max(50).optional(),
    packageIncludesHe: z.array(z.string().max(200)).max(50).optional(),
    packageIncludesAr: z.array(z.string().max(200)).max(50).optional(),
    compatibility: compatibilitySchema,
    publishContent: publishContentSchema,
    variants: z.array(variantSchema).optional(),
    wholesalePricing: wholesalePricingSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.titleHe && !b.title) {
      ctx.addIssue({ code: "custom", path: ["titleHe"], message: "titleHe or title is required" });
    }
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }
    if (b.salePrice != null && !(Number(b.salePrice) < Number(b.price))) {
      ctx.addIssue({
        code: "custom",
        path: ["salePrice"],
        message: "salePrice must be less than price",
      });
    }
  });

// NOTE: variants and images are NOT in patchBodySchema
// Use dedicated endpoints: PUT /:id/variants, PATCH /:id/images
const patchBodySchema = z
  .object({
    titleHe: z.string().min(2).max(160).optional(),
    titleAr: z.string().max(160).optional(),
    descriptionHe: z.string().max(4000).optional(),
    descriptionAr: z.string().max(4000).optional(),
    title: z.string().min(2).max(160).optional(),
    description: z.string().max(4000).optional(),
    price: z.number().min(0).optional(),
    stock: z.number().int().min(0).optional(),
    categoryId: z.string().min(1).optional(),
    imageUrl: z.string().optional(),
    isActive: z.boolean().optional(),
    salePrice: z.number().min(0).nullable().optional(),
    discountPercent: z.number().min(0).max(100).nullable().optional(),
    saleStartAt: z.string().datetime().nullable().optional(),
    saleEndAt: z.string().datetime().nullable().optional(),
    brand: z.string().max(120).optional(),
    sku: z.string().max(80).optional(),
    barcode: z.string().max(80).optional(),
    sizeLabel: z.string().max(80).optional(),
    unit: z.enum(["ml", "g", "pcs", "set"]).nullable().optional(),
    netQuantity: z.number().min(0).nullable().optional(),
    tags: z.array(z.string().max(40)).optional(),
    ingredients: z.string().max(4000).optional(),
    usage: z.string().max(4000).optional(),
    warnings: z.string().max(4000).optional(),
    manufacturerName: z.string().max(160).optional(),
    importerName: z.string().max(160).optional(),
    countryOfOrigin: z.string().max(120).optional(),
    warrantyInfo: z.string().max(400).optional(),
    catalogStatus: catalogStatusSchema.optional(),
    confidenceGrade: confidenceGradeSchema.optional(),
    verification: verificationSchema,
    identity: identitySchema,
    classification: classificationSchema,
    specs: specsSchema,
    packageIncludes: z.array(z.string().max(200)).max(50).optional(),
    packageIncludesHe: z.array(z.string().max(200)).max(50).optional(),
    packageIncludesAr: z.array(z.string().max(200)).max(50).optional(),
    compatibility: compatibilitySchema,
    publishContent: publishContentSchema,
    wholesalePricing: wholesalePricingSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }
    if (b.salePrice != null && b.price != null && !(Number(b.salePrice) < Number(b.price))) {
      ctx.addIssue({
        code: "custom",
        path: ["salePrice"],
        message: "salePrice must be less than price",
      });
    }
  });

const stockAdjustSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      delta: z.number().int(),
      reason: z.string().min(1).max(200),
      variantId: z.string().optional(),
    })
    .strict(),
});

const variantsReplaceSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      variants: z.array(variantSchema),
    })
    .strict(),
});

const productImageSchema = z.object({
  _id: z.string().optional(),
  assetId: z.string().nullable().optional(),
  url: z.string().min(1).max(512),
  secureUrl: z.string().max(512).optional(),
  altHe: z.string().max(256).optional(),
  altAr: z.string().max(256).optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const imagesUpdateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      images: z
        .array(productImageSchema)
        .max(10, "Maximum 10 images allowed"),
    })
    .strict(),
});

const productIdParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

/* ============================
   GET /api/admin/products
============================ */

router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};

    // By default, exclude soft-deleted unless explicitly requested
    if (q.isDeleted === "true") {
      filter.isDeleted = true;
    } else if (q.isDeleted === "false") {
      filter.isDeleted = { $ne: true };
    } else {
      // Default: exclude deleted
      filter.isDeleted = { $ne: true };
    }

    if (q.isActive === "true") {
      filter.isActive = true;
    } else if (q.isActive === "false") {
      filter.isActive = false;
    }

    if (q.categoryId) {
      if (!isValidObjectId(q.categoryId)) {
        throw makeErr(400, "INVALID_CATEGORY_ID", "Invalid categoryId");
      }
      filter.categoryId = q.categoryId;
    }

    if (q.brand) {
      filter.brand = q.brand;
    }

    if (q.hasVariants === "true") {
      filter["variants.0"] = { $exists: true };
    } else if (q.hasVariants === "false") {
      filter["variants.0"] = { $exists: false };
    }

    if (q.catalogStatus) {
      filter.catalogStatus = q.catalogStatus;
    }

    if (q.confidenceGrade) {
      filter.confidenceGrade = q.confidenceGrade;
    }

    if (q.unverifiedOnly === "true") {
      filter.$or = [
        { "verification.isModelVerified": { $ne: true } },
        { "verification.isCategoryVerified": { $ne: true } },
      ];
    }

    if (q.categoryMismatchOnly === "true") {
      filter.$and = [
        ...(filter.$and || []),
        { "verification.isCategoryVerified": false },
        { "classification.categoryPrimary": { $type: "string", $ne: "" } },
      ];
    }

    // Track if we're using $text search for sorting decisions
    let useTextSearch = false;
    
    if (q.search) {
      const search = String(q.search).trim().slice(0, 120);
      if (search) {
        // Use $text search for title fields (index-backed via ProductTextIndex)
        filter.$text = { $search: search };
        useTextSearch = true;
        
        // Fallback regex for slug/sku only (not in text index)
        // Skip regex if search < 3 chars to avoid expensive scans
        if (search.length >= 3) {
          const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const slugSkuRegex = new RegExp(escapedSearch, "i");
          // Note: We can't easily combine $text with $or in MongoDB.
          // The $text search covers titles; slug/sku matches would need a separate query.
          // For now, rely on $text for titles. Admins can use exact slug/sku filters separately.
          // If exact slug/sku match is critical, we could run a parallel query and merge.
          // Keeping it simple: $text handles the common case (title search).
        }
      }
    }

    // Sorting
    let sortOption = { createdAt: -1 };
    let useTextScore = false;
    
    if (q.sortBy) {
      // Explicit sortBy provided - use allowlist sort behavior
      const dir = q.sortDir === "asc" ? 1 : -1;
      sortOption = { [q.sortBy]: dir };
    } else if (useTextSearch) {
      // No explicit sortBy + text search: sort by relevance score
      sortOption = { score: { $meta: "textScore" }, createdAt: -1 };
      useTextScore = true;
    }

    // Build query with optional textScore projection
    let query = Product.find(filter);
    if (useTextScore) {
      // Project textScore for sorting by relevance
      query = query.select({ score: { $meta: "textScore" } });
    }
    
    const [items, total] = await Promise.all([
      query.sort(sortOption).skip(skip).limit(limit).lean(),
      Product.countDocuments(filter),
    ]);

    const mapped = items.map((p) => mapProductAdmin(p, req.lang));

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
   GET /api/admin/products/:id
============================ */

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const item = await Product.findById(id);
    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    return jsonRes(res, mapProductAdmin(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products/:id/recompute-catalog-status
============================ */

router.post(
  "/:id/recompute-catalog-status",
  validate(productIdParamSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return safeNotFound(res, "NOT_FOUND", "Product not found");
      }

      const product = await Product.findById(id);
      if (!product) {
        return safeNotFound(res, "NOT_FOUND", "Product not found");
      }

      await product.save();
      invalidateProductCaches();
      return jsonRes(res, mapProductAdmin(product, req.lang));
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   GET /api/admin/products/:id/qa-report
============================ */

router.get("/:id/qa-report", validate(productIdParamSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const report = await generateCatalogQaReport(id);
    return jsonRes(res, report);
  } catch (e) {
    if (e?.code === "NOT_FOUND") {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products
============================ */

router.post(
  "/",
  validate(z.object({ body: createBodySchema })),
  async (req, res) => {
    try {
      const b = req.validated.body;

      // Validate category exists before creating product
      await validateCategoryExists(b.categoryId);

      const variants = Array.isArray(b.variants)
        ? await applyCatalogValidationToVariants(
          b.variants.map((v) => ({
            ...v,
            priceOverrideMinor: v.priceOverride != null ? toMinorSafe(v.priceOverride) : null,
          }))
        )
        : [];

      const verification =
        b.verification && typeof b.verification === "object"
          ? {
              ...b.verification,
              lastVerifiedAt: b.verification.lastVerifiedAt
                ? new Date(b.verification.lastVerifiedAt)
                : null,
            }
          : undefined;

      const modelStr = String(b.identity?.model || "").trim();
      const isCategoryVerified = b.verification?.isCategoryVerified === true;
      const hasCriticalMismatch = b.verification?.hasCriticalMismatch === true;
      if (b.isActive === true && (!modelStr || !isCategoryVerified || hasCriticalMismatch)) {
        throw makeErr(400, "PUBLISH_BLOCKED", "Cannot activate product with catalogStatus HOLD");
      }

      const item = await Product.create({
        titleHe: b.titleHe || b.title || "",
        titleAr: b.titleAr || "",
        descriptionHe: b.descriptionHe || b.description || "",
        descriptionAr: b.descriptionAr || "",
        title: b.title || b.titleHe || "",
        description: b.description || b.descriptionHe || "",
        price: b.price,
        stock: b.stock,
        categoryId: b.categoryId,
        imageUrl: b.imageUrl || "",
        isActive: b.isActive ?? true,
        isDeleted: false,
        salePrice: b.salePrice ?? null,
        discountPercent: b.discountPercent ?? null,
        saleStartAt: b.saleStartAt ? new Date(b.saleStartAt) : null,
        saleEndAt: b.saleEndAt ? new Date(b.saleEndAt) : null,
        priceMinor: toMinorSafe(b.price),
        salePriceMinor: b.salePrice != null ? toMinorSafe(b.salePrice) : null,
        brand: b.brand || "",
        sku: b.sku || "",
        barcode: b.barcode || "",
        sizeLabel: b.sizeLabel || "",
        unit: b.unit ?? null,
        netQuantity: b.netQuantity ?? null,
        tags: Array.isArray(b.tags) ? b.tags : [],
        ingredients: b.ingredients || "",
        usage: b.usage || "",
        warnings: b.warnings || "",
        manufacturerName: b.manufacturerName || "",
        importerName: b.importerName || "",
        countryOfOrigin: b.countryOfOrigin || "",
        warrantyInfo: b.warrantyInfo || "",
        catalogStatus: b.catalogStatus,
        confidenceGrade: b.confidenceGrade,
        verification,
        identity: b.identity,
        classification: b.classification,
        specs: b.specs,
        packageIncludes: Array.isArray(b.packageIncludes) ? b.packageIncludes : [],
        packageIncludesHe: Array.isArray(b.packageIncludesHe) ? b.packageIncludesHe : [],
        packageIncludesAr: Array.isArray(b.packageIncludesAr) ? b.packageIncludesAr : [],
        compatibility: b.compatibility,
        publishContent: b.publishContent,
        variants,
      });

      invalidateProductCaches();
      return sendCreated(res, mapProductAdmin(item, req.lang));
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   PATCH /api/admin/products/:id
============================ */

router.patch(
  "/:id",
  validate(z.object({ params: z.object({ id: z.string().min(1) }), body: patchBodySchema })),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return safeNotFound(res, "NOT_FOUND", "Product not found");
      }

      const product = await Product.findById(id);
      if (!product) {
        return safeNotFound(res, "NOT_FOUND", "Product not found");
      }

      const b = req.validated.body;
      const patch = filterPatchFields(b);

      // Validate category exists if categoryId is being updated
      if (patch.categoryId) {
        await validateCategoryExists(patch.categoryId);
      }

      // Sync legacy fields
      if (patch.titleHe && !patch.title) patch.title = patch.titleHe;
      if (patch.descriptionHe && !patch.description) patch.description = patch.descriptionHe;

      // Handle dates
      if ("saleStartAt" in patch) {
        patch.saleStartAt = patch.saleStartAt ? new Date(patch.saleStartAt) : null;
      }
      if ("saleEndAt" in patch) {
        patch.saleEndAt = patch.saleEndAt ? new Date(patch.saleEndAt) : null;
      }

      if (patch.verification && typeof patch.verification === "object") {
        if ("lastVerifiedAt" in patch.verification) {
          patch.verification.lastVerifiedAt = patch.verification.lastVerifiedAt
            ? new Date(patch.verification.lastVerifiedAt)
            : null;
        }
      }

      // priceMinor / salePriceMinor are computed only by Product model pre-validate hooks

      // Validate salePrice against existing price if only salePrice is provided
      if ("salePrice" in patch && !("price" in patch)) {
        const currentPrice = product.price;
        if (patch.salePrice != null && !(Number(patch.salePrice) < Number(currentPrice))) {
          throw makeErr(400, "INVALID_SALE_PRICE", "salePrice must be less than price");
        }
      }

      // NOTE: variants and images are NOT allowed via generic PATCH
      // Use dedicated endpoints: PUT /:id/variants, PATCH /:id/images

      // Apply allowed fields using doc.set() to trigger model validators
      product.set(patch);

      if (patch.isActive === true && product.catalogStatus === "HOLD") {
        throw makeErr(400, "PUBLISH_BLOCKED", "Cannot activate product with catalogStatus HOLD");
      }
      await product.save();

      invalidateProductCaches();
      return jsonRes(res, mapProductAdmin(product, req.lang));
    } catch (e) {
      return jsonErr(res, e);
    }
  }
);

/* ============================
   DELETE /api/admin/products/:id (Soft Delete)
============================ */

router.delete("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const product = await Product.findById(id);
    if (!product) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    // Already deleted
    if (product.isDeleted) {
      return jsonRes(res, { deleted: true, id: product._id });
    }

    product.set({
      isDeleted: true,
      isActive: false,
      deletedAt: new Date(),
    });
    await product.save();

    invalidateProductCaches();
    return jsonRes(res, { deleted: true, id: product._id });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products/:id/restore
============================ */

router.post("/:id/restore", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const product = await Product.findById(id);
    if (!product) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    if (!product.isDeleted) {
      // Not deleted, nothing to restore
      return jsonRes(res, mapProductAdmin(product, req.lang));
    }

    product.set({
      isDeleted: false,
      deletedAt: null,
      // Keep isActive false so admin must explicitly activate
    });
    await product.save();

    invalidateProductCaches();
    return jsonRes(res, mapProductAdmin(product, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products/:id/stock-adjust
============================ */

router.post("/:id/stock-adjust", validate(stockAdjustSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const { delta, reason, variantId } = req.validated.body;

    const product = await Product.findById(id);
    if (!product) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    if (variantId) {
      // Adjust variant stock
      const variant = product.variants.find(
        (v) => String(v._id) === variantId || v.variantKey === variantId
      );
      if (!variant) {
        throw makeErr(404, "VARIANT_NOT_FOUND", "Variant not found");
      }

      const newStock = variant.stock + delta;
      if (newStock < 0) {
        throw makeErr(400, "INSUFFICIENT_STOCK", "Stock cannot go negative");
      }

      variant.stock = newStock;
      await product.save();

      invalidateProductCaches();
      return jsonRes(res, {
        productId: product._id,
        variantId: variant._id,
        previousStock: variant.stock - delta,
        newStock: variant.stock,
        delta,
        reason,
      });
    } else {
      // Adjust product-level stock
      const newStock = product.stock + delta;
      if (newStock < 0) {
        throw makeErr(400, "INSUFFICIENT_STOCK", "Stock cannot go negative");
      }

      const previousStock = product.stock;
      product.stock = newStock;
      await product.save();

      invalidateProductCaches();
      return jsonRes(res, {
        productId: product._id,
        previousStock,
        newStock: product.stock,
        delta,
        reason,
      });
    }
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PUT /api/admin/products/:id/variants
============================ */

router.put("/:id/variants", validate(variantsReplaceSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const product = await Product.findById(id);
    if (!product) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const { variants } = req.validated.body;

    const validatedVariants = await applyCatalogValidationToVariants(
      variants.map((v) => ({
        ...v,
        priceOverrideMinor: v?.priceOverride != null ? toMinorSafe(v.priceOverride) : null,
      }))
    );

    product.variants = validatedVariants;
    await product.save();

    invalidateProductCaches();
    return jsonRes(res, mapProductAdmin(product, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   PATCH /api/admin/products/:id/images
   ============================
   Replace product images array.
   Enforces:
   - Max 10 images
   - Exactly one primary image (auto-selects first if none specified)
   - URL validation
============================ */

router.patch("/:id/images", validate(imagesUpdateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const product = await Product.findById(id);
    if (!product) {
      return safeNotFound(res, "NOT_FOUND", "Product not found");
    }

    const { images } = req.validated.body;

    // Normalize images: ensure valid ObjectIds for assetId
    const normalizedImages = images.map((img, index) => ({
      assetId: img.assetId && isValidObjectId(img.assetId) ? img.assetId : null,
      url: String(img.url || "").trim(),
      secureUrl: String(img.secureUrl || img.url || "").trim(),
      altHe: String(img.altHe || "").trim().substring(0, 256),
      altAr: String(img.altAr || "").trim().substring(0, 256),
      isPrimary: Boolean(img.isPrimary),
      sortOrder: Number(img.sortOrder ?? index),
    }));

    // Ensure at least one primary image
    const hasPrimary = normalizedImages.some((img) => img.isPrimary);
    if (normalizedImages.length > 0 && !hasPrimary) {
      normalizedImages[0].isPrimary = true;
    }

    // Ensure only ONE primary
    let foundPrimary = false;
    for (const img of normalizedImages) {
      if (img.isPrimary) {
        if (foundPrimary) {
          img.isPrimary = false;
        } else {
          foundPrimary = true;
        }
      }
    }

    // Sort by sortOrder
    normalizedImages.sort((a, b) => a.sortOrder - b.sortOrder);

    // Update product
    product.images = normalizedImages;

    // Sync imageUrl with primary image if images are provided
    if (normalizedImages.length > 0) {
      const primary = normalizedImages.find((img) => img.isPrimary);
      if (primary) {
        product.imageUrl = primary.secureUrl || primary.url || product.imageUrl;
      }
    }

    await product.save();

    invalidateProductCaches();
    return jsonRes(res, mapProductAdmin(product, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products/bulk-wholesale
   Bulk set wholesale pricing for multiple products.
   mode "percentage": computes price = product.price * (1 - value/100)
   mode "absolute":   uses value directly as the price
============================ */

const bulkWholesaleBodySchema = z
  .object({
    productIds: z.array(z.string().min(1)).min(1).max(100),
    mode: z.enum(["absolute", "percentage"]),
    tiers: z
      .array(
        z.object({
          tier: z.enum(["bronze", "silver", "gold"]),
          value: z.number().min(0),
          minQty: z.number().int().min(1).default(1),
        })
      )
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.mode === "percentage") {
      b.tiers.forEach((t, i) => {
        if (t.value > 100) {
          ctx.addIssue({
            code: "custom",
            path: ["tiers", i, "value"],
            message: "Discount percentage cannot exceed 100",
          });
        }
      });
    }
    // Validate tier ordering by extracting bronze/silver/gold values
    const vals = Object.fromEntries(b.tiers.map((t) => [t.tier, t.value]));
    const { bronze, silver, gold } = vals;
    if (b.mode === "percentage") {
      if (bronze != null && silver != null && bronze >= silver) {
        ctx.addIssue({ code: "custom", path: ["tiers"], message: "Silver discount must be higher than Bronze" });
      }
      if (silver != null && gold != null && silver >= gold) {
        ctx.addIssue({ code: "custom", path: ["tiers"], message: "Gold discount must be higher than Silver" });
      }
    } else {
      if (bronze != null && silver != null && bronze <= silver) {
        ctx.addIssue({ code: "custom", path: ["tiers"], message: "Silver price must be lower than Bronze" });
      }
      if (silver != null && gold != null && silver <= gold) {
        ctx.addIssue({ code: "custom", path: ["tiers"], message: "Gold price must be lower than Silver" });
      }
    }
  });

router.post("/bulk-wholesale", validate(z.object({ body: bulkWholesaleBodySchema })), async (req, res) => {
  try {
    const { productIds, mode, tiers } = req.validated.body;

    // Validate and deduplicate product IDs
    const validIds = [...new Set(productIds)].filter((id) => isValidObjectId(id));
    if (validIds.length === 0) {
      throw makeErr(400, "INVALID_PRODUCT_IDS", "No valid product IDs provided");
    }

    // Fetch all target products in one query
    const products = await Product.find({ _id: { $in: validIds }, isDeleted: { $ne: true } })
      .select("_id price")
      .lean();

    const foundIds = new Set(products.map((p) => String(p._id)));
    const skipped = validIds.length - foundIds.size;

    if (products.length === 0) {
      return jsonRes(res, { updated: 0, skipped: validIds.length, errors: ["No products found"] });
    }

    // Build bulk write operations
    const bulkOps = products.map((product) => {
      const wholesalePricing = tiers.map((t) => {
        let price;
        if (mode === "percentage") {
          price = Math.round(product.price * (1 - t.value / 100) * 100) / 100;
        } else {
          price = t.value;
        }
        return { tier: t.tier, price, minQty: t.minQty };
      });

      return {
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { wholesalePricing, updatedAt: new Date() } },
        },
      };
    });

    const result = await Product.bulkWrite(bulkOps);
    invalidateProductCaches();

    return jsonRes(res, {
      updated: result.modifiedCount ?? products.length,
      skipped,
      errors: [],
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/products/bulk-discount
   Apply a sale discount (percent, fixed, or clear) to a scoped set of products.
   scope.target = "all" | "category" | "brand" | "products"
   discount.mode = "percent" | "fixed" | "clear"
============================ */

const bulkDiscountBodySchema = z
  .object({
    scope: z
      .object({
        target: z.enum(["all", "category", "brand", "products"]),
        categoryId: z.string().optional(),
        brand: z.string().max(120).optional(),
        productIds: z.array(z.string()).max(500).optional(),
        onlyActive: z.boolean().optional(),
      })
      .strict(),
    discount: z
      .object({
        mode: z.enum(["percent", "fixed", "clear"]),
        value: z.number().min(0).optional(),
        saleStartAt: z.string().datetime().nullable().optional(),
        saleEndAt: z.string().datetime().nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const { target, categoryId, brand, productIds } = b.scope;
    const { mode, value } = b.discount;

    if (target === "category" && !categoryId) {
      ctx.addIssue({ code: "custom", path: ["scope", "categoryId"], message: "categoryId is required when target is 'category'" });
    }
    if (target === "brand" && !brand) {
      ctx.addIssue({ code: "custom", path: ["scope", "brand"], message: "brand is required when target is 'brand'" });
    }
    if (target === "products" && (!productIds || productIds.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["scope", "productIds"], message: "productIds is required when target is 'products'" });
    }
    if ((mode === "percent" || mode === "fixed") && (value == null || isNaN(value))) {
      ctx.addIssue({ code: "custom", path: ["discount", "value"], message: "value is required for percent or fixed mode" });
    }
    if (mode === "percent" && value != null && value > 100) {
      ctx.addIssue({ code: "custom", path: ["discount", "value"], message: "Percentage cannot exceed 100" });
    }
    if (mode === "fixed" && value != null && value <= 0) {
      ctx.addIssue({ code: "custom", path: ["discount", "value"], message: "Fixed discount value must be greater than 0" });
    }
  });

router.post("/bulk-discount", validate(z.object({ body: bulkDiscountBodySchema })), async (req, res) => {
  try {
    const { scope, discount } = req.validated.body;

    // Build MongoDB filter
    const filter = { isDeleted: { $ne: true } };

    if (scope.onlyActive) {
      filter.isActive = true;
    }

    switch (scope.target) {
      case "category": {
        if (!isValidObjectId(scope.categoryId)) {
          throw makeErr(400, "INVALID_CATEGORY_ID", "Invalid categoryId");
        }
        filter.categoryId = scope.categoryId;
        break;
      }
      case "brand": {
        filter.brand = scope.brand;
        break;
      }
      case "products": {
        const validIds = [...new Set(scope.productIds)].filter((id) => isValidObjectId(id));
        if (validIds.length === 0) {
          throw makeErr(400, "INVALID_PRODUCT_IDS", "No valid product IDs provided");
        }
        filter._id = { $in: validIds };
        break;
      }
      // "all" — no extra filter
    }

    // Fetch matching products (only fields needed for computation)
    const products = await Product.find(filter).select("_id price").lean();

    if (products.length === 0) {
      return jsonRes(res, { updated: 0, skipped: 0, errors: [] });
    }

    const toMinor = (val) => (val != null ? Math.round(val * 100) : null);

    // Build bulk write operations
    const bulkOps = [];
    let skipped = 0;

    for (const product of products) {
      let fields;

      if (discount.mode === "clear") {
        fields = {
          sale: false,
          salePrice: null,
          salePriceMinor: null,
          discountPercent: null,
          saleStartAt: null,
          saleEndAt: null,
        };
      } else {
        let salePrice;
        if (discount.mode === "percent") {
          salePrice = Math.round(product.price * (1 - discount.value / 100) * 100) / 100;
        } else {
          // fixed: salePrice = price - value
          salePrice = Math.round((product.price - discount.value) * 100) / 100;
        }

        // Skip products where computed salePrice would be invalid
        if (salePrice <= 0 || salePrice >= product.price) {
          skipped++;
          continue;
        }

        const computedDiscountPct = Math.round(((product.price - salePrice) / product.price) * 10000) / 100;

        fields = {
          sale: true,
          salePrice,
          salePriceMinor: toMinor(salePrice),
          discountPercent: computedDiscountPct,
          saleStartAt: discount.saleStartAt ? new Date(discount.saleStartAt) : null,
          saleEndAt: discount.saleEndAt ? new Date(discount.saleEndAt) : null,
        };
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { ...fields, updatedAt: new Date() } },
        },
      });
    }

    if (bulkOps.length === 0) {
      return jsonRes(res, { updated: 0, skipped, errors: ["No eligible products found (all skipped due to invalid computed price)"] });
    }

    const result = await Product.bulkWrite(bulkOps);
    invalidateProductCaches();

    return jsonRes(res, {
      updated: result.modifiedCount ?? bulkOps.length,
      skipped,
      errors: [],
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
