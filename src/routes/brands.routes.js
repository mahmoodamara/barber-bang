import express from "express";

import { Product } from "../models/Product.js";
import { slugifyText } from "../utils/slug.js";
import { mapProductListItem } from "../utils/mapProduct.js";
import { sendOk, sendError, setCacheHeaders } from "../utils/response.js";

const router = express.Router();

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

function sanitizeSearchQuery(input, maxLen = 64) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const sliced = trimmed.slice(0, maxLen);
  return sliced
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBrandDescription(name, lang) {
  if (String(lang || "he").toLowerCase() === "ar") {
    return `Explore ${name} products and best picks for professional barbers.`;
  }
  return `Explore ${name} products and best picks for professional barbers.`;
}

async function fetchBrandSummaries() {
  const rows = await Product.aggregate([
    {
      $match: {
        isActive: true,
        isDeleted: { $ne: true },
        brand: { $exists: true, $type: "string" },
      },
    },
    {
      $project: {
        brand: { $trim: { input: "$brand" } },
        imageUrl: 1,
        createdAt: 1,
      },
    },
    { $match: { brand: { $ne: "" } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $toLower: "$brand" },
        name: { $first: "$brand" },
        productCount: { $sum: 1 },
        logoUrl: { $first: "$imageUrl" },
      },
    },
    { $sort: { name: 1 } },
  ]);

  return (rows || [])
    .map((row) => {
      const name = String(row?.name || "").trim();
      const slug = slugifyText(name);
      if (!name || !slug) return null;
      return {
        name,
        slug,
        productCount: Number(row?.productCount || 0),
        logoUrl: String(row?.logoUrl || ""),
      };
    })
    .filter(Boolean);
}

router.get("/", async (req, res) => {
  try {
    const q = sanitizeSearchQuery(req.query.q, 80).toLowerCase();
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 24), 1), 100);

    const all = await fetchBrandSummaries();
    const filtered = q
      ? all.filter((item) => item.name.toLowerCase().includes(q))
      : all;

    const total = filtered.length;
    const pages = Math.max(Math.ceil(total / limit), 1);
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    setCacheHeaders(res, {
      sMaxAge: 300,
      staleWhileRevalidate: 600,
      vary: "Accept-Language",
    });
    return sendOk(
      res,
      { items },
      {
        page,
        limit,
        total,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      },
    );
  } catch (e) {
    return jsonErr(res, e);
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const slug = slugifyText(String(req.params.slug || "").trim());
    if (!slug) {
      throw makeErr(404, "NOT_FOUND", "Brand not found");
    }

    const brandOptions = await fetchBrandSummaries();
    const brandSummary = brandOptions.find((item) => item.slug === slug);
    if (!brandSummary) {
      throw makeErr(404, "NOT_FOUND", "Brand not found");
    }

    const now = new Date();
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);
    const q = sanitizeSearchQuery(req.query.q);
    const sort = String(req.query.sort || "newest").trim();
    const minPrice =
      req.query.minPrice != null ? Number(req.query.minPrice) : null;
    const maxPrice =
      req.query.maxPrice != null ? Number(req.query.maxPrice) : null;
    const inStock = String(req.query.inStock || "false") === "true";
    const onSale = String(req.query.onSale || "false") === "true";
    const ratingGteRaw =
      req.query.rating_gte != null ? Number(req.query.rating_gte) : null;
    const discountGteRaw =
      req.query.discount_gte != null ? Number(req.query.discount_gte) : null;
    const ratingGte = Number.isFinite(ratingGteRaw)
      ? Math.min(Math.max(ratingGteRaw, 0), 5)
      : null;
    const discountGte = Number.isFinite(discountGteRaw)
      ? Math.min(Math.max(discountGteRaw, 0), 100)
      : null;
    const compatModel = sanitizeSearchQuery(req.query.compat_model, 80);

    const filter = {
      isActive: true,
      isDeleted: { $ne: true },
      brand: { $regex: new RegExp(`^${escapeRegex(brandSummary.name)}$`, "i") },
    };
    const andClauses = [];

    if (q) {
      filter.$text = { $search: q };
    }

    if (minPrice != null && !Number.isNaN(minPrice)) {
      filter.price = { ...(filter.price || {}), $gte: minPrice };
    }
    if (maxPrice != null && !Number.isNaN(maxPrice)) {
      filter.price = { ...(filter.price || {}), $lte: maxPrice };
    }

    if (inStock) {
      andClauses.push({
        $or: [
          { "variants.0": { $exists: false }, stock: { $gt: 0 } },
          { "variants.stock": { $gt: 0 } },
        ],
      });
    }

    if (ratingGte != null) {
      andClauses.push({
        $or: [
          { "stats.ratingAvg": { $gte: ratingGte } },
          { ratingAvg: { $gte: ratingGte } },
        ],
      });
    }

    if (onSale || discountGte != null) {
      filter.salePrice = { $ne: null };
      andClauses.push({ $expr: { $lt: ["$salePrice", "$price"] } });
      andClauses.push(
        { $or: [{ saleStartAt: null }, { saleStartAt: { $lte: now } }] },
        { $or: [{ saleEndAt: null }, { saleEndAt: { $gte: now } }] },
      );
    }

    if (discountGte != null) {
      andClauses.push({
        $expr: {
          $and: [
            { $gt: ["$price", 0] },
            {
              $gte: [
                {
                  $multiply: [
                    {
                      $divide: [{ $subtract: ["$price", "$salePrice"] }, "$price"],
                    },
                    100,
                  ],
                },
                discountGte,
              ],
            },
          ],
        },
      });
    }

    if (compatModel) {
      const compatRegex = new RegExp(escapeRegex(compatModel), "i");
      andClauses.push({
        $or: [
          { "compatibility.models.model": { $regex: compatRegex } },
          { "compatibility.models.brand": { $regex: compatRegex } },
          { "compatibility.replacementHeadCompatibleWith": { $regex: compatRegex } },
          { "identity.model": { $regex: compatRegex } },
          { "identity.productLine": { $regex: compatRegex } },
          { tags: { $regex: compatRegex } },
        ],
      });
    }

    if (andClauses.length) {
      filter.$and = andClauses;
    }

    let sortOption = { createdAt: -1 };
    if (sort === "price_asc") sortOption = { price: 1, createdAt: -1 };
    else if (sort === "price_desc") sortOption = { price: -1, createdAt: -1 };
    else if (sort === "top_rated") {
      sortOption = { "stats.ratingAvg": -1, "stats.ratingCount": -1, createdAt: -1 };
    } else if (q) {
      sortOption = { score: { $meta: "textScore" }, createdAt: -1 };
    }

    let query = Product.find(filter);
    if (q) {
      query = query.select({ score: { $meta: "textScore" } });
    }

    const [items, totalFiltered] = await Promise.all([
      query
        .sort(sortOption)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const mapped = items
      .map((product) => mapProductListItem(product, { lang: req.lang, now }))
      .filter(Boolean);
    const pages = Math.max(Math.ceil(totalFiltered / limit), 1);

    setCacheHeaders(res, {
      sMaxAge: 60,
      staleWhileRevalidate: 120,
      vary: "Accept-Language",
    });
    return sendOk(
      res,
      {
        brand: {
          ...brandSummary,
          bannerImageUrl: brandSummary.logoUrl || "",
          description: buildBrandDescription(brandSummary.name, req.lang),
        },
        items: mapped,
      },
      {
        page,
        limit,
        total: totalFiltered,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      },
    );
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
