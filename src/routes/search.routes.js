import express from "express";

import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { slugifyText } from "../utils/slug.js";
import { sendError, sendOk, setCacheHeaders } from "../utils/response.js";
import { MemoryCache, withCache } from "../utils/cache.js";

const router = express.Router();

const SUGGEST_MAX_LIMIT = 8;
const SUGGEST_DEFAULT_LIMIT = 5;
const SUGGEST_CACHE_TTL_MS = 2 * 60 * 1000;
const SUGGEST_CACHE_STALE_MS = 45 * 1000;

function jsonErr(res, e) {
  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || "INTERNAL_ERROR",
    e?.message || "Unexpected error",
  );
}

function sanitizeSearchQuery(input, maxLen = 80) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  return trimmed
    .slice(0, maxLen)
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLang(raw) {
  return String(raw || "").toLowerCase() === "ar" ? "ar" : "he";
}

function localize(obj, field, lang) {
  const he = String(obj?.[`${field}He`] || obj?.[field] || "").trim();
  const ar = String(obj?.[`${field}Ar`] || "").trim();
  return lang === "ar" ? ar || he : he || ar;
}

function getMainImage(product) {
  if (Array.isArray(product?.images) && product.images.length > 0) {
    const primary = product.images.find((img) => Boolean(img?.isPrimary));
    const source = primary || product.images[0];
    return String(source?.secureUrl || source?.url || product?.imageUrl || "");
  }
  return String(product?.imageUrl || "");
}

async function fetchProductSuggestions(query, limit, lang) {
  const baseFilter = { isActive: true, isDeleted: { $ne: true } };
  const projection =
    "_id slug titleHe titleAr title brand imageUrl images createdAt";

  const products = [];
  const seen = new Set();

  if (query.length >= 2) {
    const textMatched = await Product.find(
      { ...baseFilter, $text: { $search: query } },
      projection,
    )
      .sort({ score: { $meta: "textScore" }, createdAt: -1 })
      .limit(limit)
      .lean();

    for (const item of textMatched) {
      const id = String(item?._id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      products.push(item);
    }
  }

  if (products.length < limit) {
    const regex = new RegExp(escapeRegex(query), "i");
    const regexMatched = await Product.find(
      {
        ...baseFilter,
        $or: [
          { titleHe: { $regex: regex } },
          { titleAr: { $regex: regex } },
          { title: { $regex: regex } },
          { brand: { $regex: regex } },
        ],
      },
      projection,
    )
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .lean();

    for (const item of regexMatched) {
      if (products.length >= limit) break;
      const id = String(item?._id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      products.push(item);
    }
  }

  return products.slice(0, limit).map((item) => {
    const id = String(item?._id || "");
    const slug = String(item?.slug || "").trim();
    return {
      id,
      _id: id,
      slug,
      slugOrId: slug || id,
      title: localize(item, "title", lang),
      brand: String(item?.brand || "").trim(),
      imageUrl: String(item?.imageUrl || ""),
      mainImage: getMainImage(item),
    };
  });
}

async function fetchBrandSuggestions(query, limit) {
  const regex = new RegExp(escapeRegex(query), "i");
  const rows = await Product.aggregate([
    {
      $match: {
        isActive: true,
        isDeleted: { $ne: true },
        brand: { $exists: true, $type: "string", $ne: "" },
      },
    },
    {
      $project: {
        brand: { $trim: { input: "$brand" } },
        imageUrl: 1,
        createdAt: 1,
      },
    },
    { $match: { brand: { $regex: regex } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $toLower: "$brand" },
        name: { $first: "$brand" },
        logoUrl: { $first: "$imageUrl" },
        productCount: { $sum: 1 },
      },
    },
    { $sort: { productCount: -1, name: 1 } },
    { $limit: limit },
  ]);

  return (rows || [])
    .map((row) => {
      const name = String(row?.name || "").trim();
      if (!name) return null;
      return {
        name,
        slug: slugifyText(name),
        logoUrl: String(row?.logoUrl || ""),
        productCount: Number(row?.productCount || 0),
      };
    })
    .filter(Boolean)
    .filter((item) => Boolean(item.slug));
}

async function fetchCategorySuggestions(query, limit, lang) {
  const regex = new RegExp(escapeRegex(query), "i");
  const rows = await Category.find({
    isActive: true,
    $or: [
      { nameHe: { $regex: regex } },
      { nameAr: { $regex: regex } },
      { name: { $regex: regex } },
    ],
  })
    .sort({ sortOrder: 1, createdAt: -1 })
    .limit(limit)
    .lean();

  return (rows || []).map((item) => {
    const id = String(item?._id || "");
    return {
      id,
      _id: id,
      slug: String(item?.slug || ""),
      name: localize(item, "name", lang),
      imageUrl: String(item?.imageUrl || ""),
    };
  });
}

router.get("/suggest", async (req, res) => {
  try {
    const q = sanitizeSearchQuery(req.query.q, 80);
    if (!q) {
      return sendOk(res, { q: "", products: [], brands: [], categories: [] });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), SUGGEST_MAX_LIMIT)
      : SUGGEST_DEFAULT_LIMIT;

    const lang = normalizeLang(req.lang);
    const cacheKey = MemoryCache.buildKey("search:suggest", {
      q: q.toLowerCase(),
      limit,
      lang,
    });

    const { data } = await withCache(
      cacheKey,
      async () => {
        const [products, brands, categories] = await Promise.all([
          fetchProductSuggestions(q, limit, lang),
          fetchBrandSuggestions(q, limit),
          fetchCategorySuggestions(q, limit, lang),
        ]);

        return { q, products, brands, categories };
      },
      {
        ttlMs: SUGGEST_CACHE_TTL_MS,
        staleMs: SUGGEST_CACHE_STALE_MS,
      },
    );

    setCacheHeaders(res, {
      sMaxAge: 60,
      staleWhileRevalidate: 120,
      vary: "Accept-Language",
    });
    return sendOk(res, data);
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
