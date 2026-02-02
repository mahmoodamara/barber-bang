// src/routes/collections.routes.js
// Smart Collections APIs for Israeli e-commerce market (hardened + more consistent)

import express from "express";
import mongoose from "mongoose";
import { z } from "zod";

import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

/* ============================
   Helpers
============================ */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

function makeErr(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function jsonErr(res, e) {
  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || "INTERNAL_ERROR",
    e?.message || "Unexpected error",
    e?.details ? { details: e.details } : undefined
  );
}

const asyncHandler =
  (fn) =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      return jsonErr(res, e);
    }
  };

function isSaleActiveByPrice(p, now = new Date()) {
  if (p?.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < new Date(p.saleStartAt)) return false;
  if (p.saleEndAt && now > new Date(p.saleEndAt)) return false;
  return true;
}

// Safer money to minor (always int >=0)
function toMinorSafe(major) {
  const n = Number(major);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function mapProductImage(img, lang) {
  const alt =
    lang === "ar"
      ? String(img?.altAr || img?.altHe || "")
      : String(img?.altHe || img?.altAr || "");

  return {
    id: img?._id ? String(img._id) : null,
    url: String(img?.url || ""),
    secureUrl: String(img?.secureUrl || img?.url || ""),
    alt,
    isPrimary: Boolean(img?.isPrimary),
    sortOrder: Number(img?.sortOrder || 0),
  };
}

function getMainImage(p) {
  const fallback = String(p?.imageUrl || "");
  if (!Array.isArray(p?.images) || p.images.length === 0) return fallback;

  const primary = p.images.find((img) => img?.isPrimary);
  const pick = primary || p.images[0];
  return String(pick?.secureUrl || pick?.url || fallback);
}

/**
 * Public collection product DTO (avoid leaking internal raw stats object)
 */
function mapCollectionProduct(p, lang, now = new Date()) {
  const onSale = isSaleActiveByPrice(p, now);
  const images = Array.isArray(p.images) ? p.images.map((img) => mapProductImage(img, lang)) : [];

  return {
    id: String(p._id),
    _id: p._id,

    title: t(p, "title", lang),
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",

    price: Number(p.price || 0),
    priceMinor: toMinorSafe(p.price),

    stock: Number(p.stock || 0),
    categoryId: p.categoryId || null,

    imageUrl: String(p.imageUrl || ""),
    mainImage: getMainImage(p),
    images,

    isActive: Boolean(p.isActive),
    brand: String(p.brand || ""),
    slug: String(p.slug || ""),

    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          salePriceMinor: toMinorSafe(p.salePrice),
          discountPercent: p.discountPercent ?? null,
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,
        }
      : null,

    // curated exposed metrics (not raw internal stats object)
    stats: null,
    avgRating: p.avgRating ?? null,
    reviewCount: p.reviewCount ?? null,
    unitsSold: p.unitsSold ?? null,
    trendScore: p.trendScore ?? null,
  };
}

/* ============================
   Query Schema (shared)
   - Strict allowlist (no passthrough)
   - Coerce numbers for safer parsing
============================ */

const collectionQuerySchema = z.object({
  query: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      categoryId: z.string().optional(),
      lang: z.enum(["he", "ar"]).optional(),
    })
    .strict()
    .optional(),
});

function parseCollectionQuery(req) {
  const q = req.validated?.query || {};
  const limit = q.limit ?? 12;

  const categoryIdRaw = String(q.categoryId || "").trim();
  const categoryId = categoryIdRaw && isValidObjectId(categoryIdRaw) ? categoryIdRaw : "";

  return { limit, categoryId };
}

function buildBaseFilter(categoryId) {
  const filter = { isActive: true, isDeleted: { $ne: true } };
  if (categoryId) {
    filter.categoryId = toObjectId(categoryId);
  }
  return filter;
}

function setPublicCache(res, seconds) {
  // Add stale-while-revalidate to smooth traffic spikes (CDN-friendly)
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=60`);
}

/* ============================
   Product projection (reduce payload + improve perf)
============================ */

const PRODUCT_PUBLIC_SELECT =
  "_id title titleHe titleAr price salePrice saleStartAt saleEndAt discountPercent stock categoryId imageUrl images isActive brand slug avgRating reviewCount unitsSold trendScore salesScore ratingScore finalRankScore stats";

/* ============================
   GET /api/v1/collections/best-sellers
   Rank by Product.salesScore (precomputed)
============================ */

router.get(
  "/best-sellers",
  validate(collectionQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, categoryId } = parseCollectionQuery(req);
    const now = new Date();

    const baseFilter = buildBaseFilter(categoryId);

    const products = await Product.find(baseFilter)
      .select(PRODUCT_PUBLIC_SELECT)
      .sort({ salesScore: -1, finalRankScore: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const items = products.map((p) => mapCollectionProduct(p, req.lang, now));

    setPublicCache(res, 300);
    return sendOk(res, { items });
  })
);

/* ============================
   GET /api/v1/collections/trending
   Compare last 7 days vs previous 30->7 baseline
   - Uses allowlisted statuses
   - Reduces DB load by fetching only needed products
============================ */

const TREND_STATUSES = ["paid", "payment_received", "stock_confirmed", "confirmed", "shipped", "delivered"];

router.get(
  "/trending",
  validate(collectionQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, categoryId } = parseCollectionQuery(req);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const recentPipeline = [
      { $match: { status: { $in: TREND_STATUSES }, createdAt: { $gte: sevenDaysAgo } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.productId", recentSales: { $sum: "$items.qty" } } },
    ];

    const baselinePipeline = [
      { $match: { status: { $in: TREND_STATUSES }, createdAt: { $gte: thirtyDaysAgo, $lt: sevenDaysAgo } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.productId", baselineSales: { $sum: "$items.qty" } } },
    ];

    const [recentData, baselineData] = await Promise.all([
      Order.aggregate(recentPipeline),
      Order.aggregate(baselinePipeline),
    ]);

    const recentMap = new Map(recentData.map((r) => [String(r._id), Number(r.recentSales || 0)]));
    const baselineMap = new Map(baselineData.map((b) => [String(b._id), Number(b.baselineSales || 0)]));

    const productIds = [...new Set([...recentMap.keys(), ...baselineMap.keys()])];
    if (!productIds.length) {
      setPublicCache(res, 300);
      return sendOk(res, { items: [] });
    }

    const baseFilter = buildBaseFilter(categoryId);
    baseFilter._id = { $in: productIds.map((id) => toObjectId(id)) };

    const products = await Product.find(baseFilter).select(PRODUCT_PUBLIC_SELECT).lean();

    // Score: recent / (baseline/4 + 1)
    const scored = products.map((p) => {
      const recent = recentMap.get(String(p._id)) || 0;
      const baseline = baselineMap.get(String(p._id)) || 0;
      const weeklyBaseline = baseline / 4;
      const trendScore = recent / (weeklyBaseline + 1);
      return { ...p, trendScore, unitsSold: recent };
    });

    const sorted = scored
      .filter((p) => p.trendScore > 0)
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, limit);

    const items = sorted.map((p) => mapCollectionProduct(p, req.lang, now));

    setPublicCache(res, 300);
    return sendOk(res, { items });
  })
);

/* ============================
   GET /api/v1/collections/top-rated
   Rank by ratingScore with a reviewCount threshold (>= 10)
============================ */

router.get(
  "/top-rated",
  validate(collectionQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, categoryId } = parseCollectionQuery(req);
    const now = new Date();

    const baseFilter = buildBaseFilter(categoryId);
    // Enforce threshold (comment in original claimed this)
    baseFilter.reviewCount = { $gte: 10 };

    const products = await Product.find(baseFilter)
      .select(PRODUCT_PUBLIC_SELECT)
      .sort({ ratingScore: -1, finalRankScore: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const items = products.map((p) => mapCollectionProduct(p, req.lang, now));

    setPublicCache(res, 600);
    return sendOk(res, { items });
  })
);

/* ============================
   GET /api/v1/collections/most-viewed
   Rank by stats.views
============================ */

router.get(
  "/most-viewed",
  validate(collectionQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, categoryId } = parseCollectionQuery(req);
    const now = new Date();

    const baseFilter = buildBaseFilter(categoryId);
    baseFilter["stats.views"] = { $gt: 0 };

    const products = await Product.find(baseFilter)
      .select(PRODUCT_PUBLIC_SELECT)
      .sort({ "stats.views": -1 })
      .limit(limit)
      .lean();

    const items = products.map((p) => mapCollectionProduct(p, req.lang, now));

    setPublicCache(res, 300);
    return sendOk(res, { items });
  })
);

/* ============================
   GET /api/v1/collections/most-wishlisted
   Rank by stats.wishlisted
============================ */

router.get(
  "/most-wishlisted",
  validate(collectionQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, categoryId } = parseCollectionQuery(req);
    const now = new Date();

    const baseFilter = buildBaseFilter(categoryId);
    baseFilter["stats.wishlisted"] = { $gt: 0 };

    const products = await Product.find(baseFilter)
      .select(PRODUCT_PUBLIC_SELECT)
      .sort({ "stats.wishlisted": -1 })
      .limit(limit)
      .lean();

    const items = products.map((p) => mapCollectionProduct(p, req.lang, now));

    setPublicCache(res, 300);
    return sendOk(res, { items });
  })
);

export default router;
