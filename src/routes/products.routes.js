// src/routes/products.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { ProductAttribute } from "../models/ProductAttribute.js";
import { Review } from "../models/Review.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { t } from "../utils/i18n.js";
import { sanitizePlainText } from "../utils/sanitize.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { recordProductEngagement, recalculateProductRatingStats } from "../services/ranking.service.js";

const router = express.Router();

/* -------------------------------- Helpers -------------------------------- */

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

function sendNotFound(res) {
  return sendError(res, 404, "NOT_FOUND", "Product not found");
}

function sanitizeSearchQuery(input, maxLen = 64) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const sliced = trimmed.slice(0, maxLen);
  return sliced.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

/**
 * ✅ Prompt rule:
 * onSale = salePrice exists AND salePrice < price
 * + optional date window check
 */
function isSaleActiveByPrice(p, now = new Date()) {
  if (p?.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < new Date(p.saleStartAt)) return false;
  if (p.saleEndAt && now > new Date(p.saleEndAt)) return false;
  return true;
}

function toMinorSafe(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function normalizeKey(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  return v
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildLegacyAttributes(variant) {
  if (!variant) return [];
  const legacy = [
    { key: "volume_ml", type: "number", value: variant.volumeMl, unit: "ml" },
    { key: "weight_g", type: "number", value: variant.weightG, unit: "g" },
    { key: "pack_count", type: "number", value: variant.packCount, unit: "" },
    { key: "scent", type: "text", value: variant.scent },
    { key: "hold_level", type: "text", value: variant.holdLevel },
    { key: "finish_type", type: "text", value: variant.finishType },
    { key: "skin_type", type: "text", value: variant.skinType },
  ];

  return legacy
    .map((a) => {
      if (a.type === "number") {
        const n = Number(a.value);
        if (!Number.isFinite(n)) return null;
        return { ...a, value: n };
      }
      const s = String(a.value || "").trim();
      if (!s) return null;
      return { ...a, value: s };
    })
    .filter(Boolean);
}

function normalizeAttributesInput(attrs) {
  const list = Array.isArray(attrs) ? attrs : [];
  return list
    .map((a) => ({
      key: normalizeKey(a?.key),
      type: String(a?.type || ""),
      value: a?.value ?? null,
      valueKey: normalizeKey(a?.valueKey),
      unit: String(a?.unit || ""),
    }))
    .filter((a) => a.key);
}

function mergeAttributesWithLegacy(variant) {
  const attrs = normalizeAttributesInput(variant?.attributes);
  const keys = new Set(attrs.map((a) => a.key));
  for (const la of buildLegacyAttributes(variant)) {
    if (!keys.has(la.key)) attrs.push(la);
  }
  return attrs;
}

function legacyAttributesObject(list) {
  const obj = {
    volumeMl: null,
    weightG: null,
    packCount: null,
    scent: "",
    holdLevel: "",
    finishType: "",
    skinType: "",
  };

  for (const a of list || []) {
    const key = String(a?.key || "");
    const val = a?.value;
    if (key === "volume_ml" && Number.isFinite(Number(val))) obj.volumeMl = Number(val);
    if (key === "weight_g" && Number.isFinite(Number(val))) obj.weightG = Number(val);
    if (key === "pack_count" && Number.isFinite(Number(val))) obj.packCount = Number(val);
    if (key === "scent" && typeof val === "string") obj.scent = val;
    if (key === "hold_level" && typeof val === "string") obj.holdLevel = val;
    if (key === "finish_type" && typeof val === "string") obj.finishType = val;
    if (key === "skin_type" && typeof val === "string") obj.skinType = val;
  }

  return obj;
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

/**
 * Map product image for public API response
 */
function mapProductImage(img, lang) {
  return {
    id: img?._id ? String(img._id) : null,
    url: img?.url || "",
    secureUrl: img?.secureUrl || img?.url || "",
    alt: lang === "ar" ? (img?.altAr || img?.altHe || "") : (img?.altHe || img?.altAr || ""),
    isPrimary: Boolean(img?.isPrimary),
    sortOrder: Number(img?.sortOrder || 0),
  };
}

/**
 * Get main image URL from product (primary from images[] or fallback to imageUrl)
 */
function getMainImage(p) {
  if (Array.isArray(p.images) && p.images.length > 0) {
    const primary = p.images.find((img) => img.isPrimary);
    if (primary) {
      return primary.secureUrl || primary.url || p.imageUrl || "";
    }
    // Fallback to first image if no primary marked
    const first = p.images[0];
    return first?.secureUrl || first?.url || p.imageUrl || "";
  }
  return p.imageUrl || "";
}

function mapProductListItem(p, lang, now) {
  const onSale = isSaleActiveByPrice(p, now);

  // Map images array
  const images = Array.isArray(p.images) ? p.images.map((img) => mapProductImage(img, lang)) : [];

  return {
    id: p._id,
    _id: p._id,

    // ✅ Unified fields used by frontend
    title: t(p, "title", lang),
    description: t(p, "description", lang),

    // ✅ Additive bilingual (does not break anything)
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    descriptionHe: p.descriptionHe || p.description || "",
    descriptionAr: p.descriptionAr || "",

    price: Number(p.price || 0),
    stock: Number(p.stock || 0),
    categoryId: p.categoryId || null,
    imageUrl: p.imageUrl || "",
    mainImage: getMainImage(p),
    images,
    isActive: Boolean(p.isActive),

    brand: p.brand || "",
    sku: p.sku || "",
    barcode: p.barcode || "",
    sizeLabel: p.sizeLabel || "",
    unit: p.unit ?? null,
    netQuantity: p.netQuantity ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    ingredients: p.ingredients || "",
    usage: p.usage || "",
    warnings: p.warnings || "",
    manufacturerName: p.manufacturerName || "",
    importerName: p.importerName || "",
    countryOfOrigin: p.countryOfOrigin || "",
    warrantyInfo: p.warrantyInfo || "",
    slug: p.slug || "",

    variants: Array.isArray(p.variants) ? p.variants.map(mapVariant) : [],

    // NOTE: isFeatured/isBestSeller removed from public API.
    // Rankings must be computed from real data via ranking endpoints.
    // See: NO MANUAL FLAGS store rule.

    // ✅ Sale block only when active by rule
    sale: onSale
      ? {
        salePrice: Number(p.salePrice || 0),
        discountPercent: p.discountPercent ?? null, // ✅ additive
        saleStartAt: p.saleStartAt || null,
        saleEndAt: p.saleEndAt || null,
      }
      : null,
  };
}

function mapProductDetailsDoc(item, lang) {
  // item is mongoose doc
  const obj = item.toObject();
  const {
    stats,
    salesScore,
    popularityScore,
    ratingScore,
    finalRankScore,
    rankUpdatedAt,
    rankLastActivityAt,
    isFeatured,
    isBestSeller,
    ...clean
  } = obj;
  const now = new Date();
  const onSale = isSaleActiveByPrice(obj, now);

  // Map images array
  const images = Array.isArray(obj.images) ? obj.images.map((img) => mapProductImage(img, lang)) : [];

  return {
    ...clean,

    // ✅ Unified fields
    title: t(obj, "title", lang),
    description: t(obj, "description", lang),

    // ✅ Multi-image support
    mainImage: getMainImage(obj),
    images,

    // ✅ Normalize sale output
    sale: onSale
      ? {
        salePrice: Number(obj.salePrice || 0),
        saleStartAt: obj.saleStartAt || null,
        saleEndAt: obj.saleEndAt || null,
      }
      : null,

    variants: Array.isArray(obj.variants) ? obj.variants.map(mapVariant) : [],
  };
}

/* ============================================================================
   PRODUCTS LISTING (Filters + Pagination)
   GET /api/products?q&categoryId&minPrice&maxPrice&onSale&inStock&featured&sort&page&limit
============================================================================ */

router.get("/", async (req, res) => {
  try {
    const now = new Date();

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);

    const q = sanitizeSearchQuery(req.query.q);
    const categoryId = String(req.query.categoryId || "").trim();
    const minPrice = req.query.minPrice != null ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice != null ? Number(req.query.maxPrice) : null;

    const onSale = String(req.query.onSale || "false") === "true";
    const inStock = String(req.query.inStock || "false") === "true";
    // NOTE: `featured` query param is IGNORED for public endpoints.
    // Featured/best-seller lists must use the ranking endpoints (/products/featured, /products/best-sellers).
    // See: NO MANUAL FLAGS store rule.
    const sort = String(req.query.sort || "newest").trim();

    const filter = { isActive: true, isDeleted: { $ne: true } };

    // Text search (uses text index)
    if (q) {
      filter.$text = { $search: q };
    }

    // Category filter
    if (categoryId) {
      if (!isValidObjectId(categoryId)) {
        throw makeErr(400, "VALIDATION_ERROR", "Invalid categoryId");
      }
      filter.categoryId = categoryId;
    }

    // Price range filters (base price)
    if (minPrice != null && !Number.isNaN(minPrice)) {
      filter.price = { ...(filter.price || {}), $gte: minPrice };
    }
    if (maxPrice != null && !Number.isNaN(maxPrice)) {
      filter.price = { ...(filter.price || {}), $lte: maxPrice };
    }

    // In stock filter
    if (inStock) {
      filter.$or = [
        { "variants.0": { $exists: false }, stock: { $gt: 0 } },
        { "variants.stock": { $gt: 0 } },
      ];
    }

    // NOTE: Featured filter removed - use ranking endpoints instead.
    // See: NO MANUAL FLAGS store rule.

    /**
     * ✅ On sale filter (prompt rule + date window)
     * salePrice exists AND salePrice < price
     * AND (saleStartAt null OR saleStartAt <= now)
     * AND (saleEndAt null OR saleEndAt >= now)
     */
    if (onSale) {
      filter.salePrice = { $ne: null };
      filter.$expr = { $lt: ["$salePrice", "$price"] };

      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [{ saleStartAt: null }, { saleStartAt: { $lte: now } }],
        },
        {
          $or: [{ saleEndAt: null }, { saleEndAt: { $gte: now } }],
        },
      ];
    }

    // Sort
    let sortOption = { createdAt: -1 };
    if (sort === "price_asc") sortOption = { price: 1, createdAt: -1 };
    else if (sort === "price_desc") sortOption = { price: -1, createdAt: -1 };
    else if (q) sortOption = { score: { $meta: "textScore" }, createdAt: -1 };

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(sortOption)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const mapped = items.map((p) => mapProductListItem(p, req.lang, now));
    const pages = Math.ceil(total / limit);

    return sendOk(
      res,
      { items: mapped },
      {
        page,
        limit,
        total,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      }
    );
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   PRODUCT DETAILS
   GET /api/products/:slugOrId
============================================================================ */

router.get("/:slugOrId", async (req, res) => {
  try {
    const slugOrId = String(req.params.slugOrId || "").trim();
    if (!slugOrId) {
      return sendNotFound(res);
    }

    const filter = { isActive: true, isDeleted: { $ne: true } };
    if (isValidObjectId(slugOrId)) {
      filter._id = slugOrId;
    } else {
      filter.slug = slugOrId.toLowerCase();
    }
    const item = await Product.findOne(filter);
    if (!item) {
      return sendNotFound(res);
    }

    // ✅ Track product detail view (best-effort, abuse-protected)
    recordProductEngagement({
      productId: item._id,
      type: "view",
      userId: req.user?._id || null,
      ip: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
      now: new Date(),
    }).catch(() => {});

    return sendOk(res, mapProductDetailsDoc(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   REVIEWS
   1) GET  /api/products/:id/reviews?page&limit
   2) POST /api/products/:id/reviews  (Protected)
============================================================================ */

const reviewsListSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: z
    .object({
      page: z.string().optional(),
      limit: z.string().optional(),
    })
    .optional(),
});

router.get("/:id/reviews", validate(reviewsListSchema), async (req, res) => {
  try {
    const productId = String(req.params.id || "");
    if (!isValidObjectId(productId)) {
      return sendNotFound(res);
    }

    const exists = await Product.exists({ _id: productId, isActive: true, isDeleted: { $ne: true } });
    if (!exists) {
      return sendNotFound(res);
    }

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);

    const [items, total, stats] = await Promise.all([
      Review.find({
        productId,
        isHidden: { $ne: true },
        $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
      })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Review.countDocuments({
        productId,
        isHidden: { $ne: true },
        $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
      }),
      Review.aggregate([
        {
          $match: {
            productId: new mongoose.Types.ObjectId(productId),
            isHidden: { $ne: true },
            $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
          },
        },
        { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
    ]);

    const avgRatingRaw = stats?.[0]?.avgRating ?? 0;
    const count = stats?.[0]?.count ?? 0;
    const pages = Math.ceil(total / limit);

    return sendOk(
      res,
      {
        items: items.map((r) => ({
          id: r._id,
          _id: r._id,
          rating: Number(r.rating || 0),
          comment: sanitizePlainText(r.comment || "", { maxLen: 600 }),
          createdAt: r.createdAt,
          userId: r.userId, // keep minimal; safe enough
        })),
        avgRating: Math.round((Number(avgRatingRaw) + Number.EPSILON) * 10) / 10, // 1 decimal
        count,
      },
      {
        page,
        limit,
        total,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      }
    );
  } catch (e) {
    return jsonErr(res, e);
  }
});

const reviewCreateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(600).optional(),
  }),
});

/**
 * Rule:
 * - prevent multiple reviews per user per product
 * ✅ choose: update existing (better UX)
 */
router.post("/:id/reviews", requireAuth(), validate(reviewCreateSchema), async (req, res) => {
  try {
    const productId = String(req.params.id || "");
    if (!isValidObjectId(productId)) {
      return sendNotFound(res);
    }

    const exists = await Product.exists({ _id: productId, isActive: true, isDeleted: { $ne: true } });
    if (!exists) {
      return sendNotFound(res);
    }

    const { rating, comment } = req.validated.body;
    const safeComment = sanitizePlainText(comment || "", { maxLen: 600 });

    const updated = await Review.findOneAndUpdate(
      { productId, userId: req.user._id },
      {
        $set: {
          rating,
          comment: safeComment,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    await recalculateProductRatingStats(updated.productId).catch(() => {});

    return sendCreated(res, {
      id: updated._id,
      _id: updated._id,
      productId: updated.productId,
      userId: updated.userId,
      rating: updated.rating,
      comment: updated.comment || "",
      createdAt: updated.createdAt,
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   ADMIN CREATE / UPDATE / DELETE PRODUCTS
============================================================================ */
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

    variants: z
      .array(
        z.object({
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
        })
      )
      .optional(),
  })
  .superRefine((b, ctx) => {
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }

    // ✅ only validate this in CREATE (price is required here)
    if (b.salePrice != null && !(Number(b.salePrice) < Number(b.price))) {
      ctx.addIssue({
        code: "custom",
        path: ["salePrice"],
        message: "salePrice must be less than price to be considered on sale",
      });
    }
  });

const updateBodySchema = z
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

    variants: z
      .array(
        z.object({
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
        })
      )
      .optional(),
  })
  .superRefine((b, ctx) => {
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }

    // ✅ validate salePrice < price ONLY if both provided in update payload
    if (b.salePrice != null && b.price != null) {
      if (!(Number(b.salePrice) < Number(b.price))) {
        ctx.addIssue({
          code: "custom",
          path: ["salePrice"],
          message: "salePrice must be less than price to be considered on sale",
        });
      }
    }
  });

const createSchema = z.object({
  body: createBodySchema,
});


router.post("/", requireAuth(), requireRole("admin"), validate(createSchema), async (req, res) => {
  try {
    const b = req.validated.body;

    const variants = Array.isArray(b.variants)
      ? await applyCatalogValidationToVariants(
        b.variants.map((v) => ({
          ...v,
          priceOverrideMinor: v.priceOverride != null ? toMinorSafe(v.priceOverride) : null,
        }))
      )
      : [];

    const item = await Product.create({
      titleHe: b.titleHe || b.title || "",
      titleAr: b.titleAr || "",
      descriptionHe: b.descriptionHe || b.description || "",
      descriptionAr: b.descriptionAr || "",

      // legacy fields (optional)
      title: b.title || b.titleHe || "",
      description: b.description || b.descriptionHe || "",

      price: b.price,
      stock: b.stock,
      categoryId: b.categoryId,
      imageUrl: b.imageUrl || "",

      isActive: b.isActive ?? true,

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

      variants,
    });

    return sendCreated(res, mapProductDetailsDoc(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: updateBodySchema,
});

router.put(
  "/:id",
  requireAuth(),
  requireRole("admin"),
  validate(updateSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return sendNotFound(res);
      }

      const b = req.validated.body;
      const patch = { ...b };

      // Keep legacy synced if someone updates HE fields
      if (patch.titleHe && !patch.title) patch.title = patch.titleHe;
      if (patch.descriptionHe && !patch.description) patch.description = patch.descriptionHe;

      // ISO string -> Date
      if ("saleStartAt" in patch)
        patch.saleStartAt = patch.saleStartAt ? new Date(patch.saleStartAt) : null;
      if ("saleEndAt" in patch)
        patch.saleEndAt = patch.saleEndAt ? new Date(patch.saleEndAt) : null;

      // Normalize salePrice clearing
      if ("salePrice" in patch && patch.salePrice === undefined) delete patch.salePrice;

      if ("price" in patch) patch.priceMinor = toMinorSafe(patch.price);
      if ("salePrice" in patch) {
        patch.salePriceMinor = patch.salePrice != null ? toMinorSafe(patch.salePrice) : null;
      }

      if ("variants" in patch && Array.isArray(patch.variants)) {
        patch.variants = await applyCatalogValidationToVariants(
          patch.variants.map((v) => ({
            ...v,
            priceOverrideMinor: v?.priceOverride != null ? toMinorSafe(v.priceOverride) : null,
          }))
        );
      }

      const item = await Product.findByIdAndUpdate(id, patch, { new: true });
      if (!item) {
        return sendNotFound(res);
      }

      return sendOk(res, mapProductDetailsDoc(item, req.lang));
    } catch (e) {
      return jsonErr(res, e);
    }
  },
);

router.delete("/:id", requireAuth(), requireRole("admin"), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return sendNotFound(res);
    }

    // Soft delete: set isDeleted=true, isActive=false, deletedAt=now
    const item = await Product.findByIdAndUpdate(
      id,
      {
        $set: {
          isDeleted: true,
          isActive: false,
          deletedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!item) {
      return sendNotFound(res);
    }

    return sendOk(res, { deleted: true, id: item._id });
  } catch (e) {
    return jsonErr(res, e);
  }
});


export default router;
