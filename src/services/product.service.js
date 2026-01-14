import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { Variant } from "../models/Variant.js";
import { Category } from "../models/Category.js";
import { parsePagination } from "../utils/paginate.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { getCategorySlugCache, setCategorySlugCache } from "../utils/categoryCache.js";
import { toMajorUnits } from "../utils/money.js";

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ✅ Stock resolver (schema-agnostic)
 * Supports Variant fields:
 * - available (preferred if exists)
 * - stock
 * - stockReserved
 */
function resolveVariantAvailable(v) {
  const reserved = Number(v?.stockReserved ?? 0);

  // Some schemas store "available" directly
  const hasAvailableField = v && Object.prototype.hasOwnProperty.call(v, "available");
  if (hasAvailableField) {
    const a = Number(v.available ?? 0);
    // if schema uses "available" as final available, don't subtract reserved twice
    // but if reserved is tracked separately, subtract defensively:
    return Math.max(0, a - reserved);
  }

  // Classic stock - reserved
  const stock = Number(v?.stock ?? 0);
  return Math.max(0, stock - reserved);
}

export async function createProduct(payload) {
  return Product.create({
    nameHe: payload.nameHe,
    nameAr: payload.nameAr,
    descriptionHe: payload.descriptionHe,
    descriptionAr: payload.descriptionAr,
    brand: payload.brand,
    categoryIds: (payload.categoryIds || []).map(oid),
    images: payload.images || [],
    slug: payload.slug,
    isActive: payload.isActive ?? true,
    attributes: payload.attributes || {},

    // inStock is derived from variants (stock.service recomputes it)
    inStock: false,
    isDeleted: false,
  });
}

export async function updateProduct(productId, patch) {
  const prod = await Product.findOne({ _id: productId, isDeleted: { $ne: true } });
  if (!prod) {
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const setIf = (k, v) => {
    if (v !== undefined) prod[k] = v;
  };

  setIf("nameHe", patch.nameHe);
  setIf("nameAr", patch.nameAr);
  setIf("descriptionHe", patch.descriptionHe);
  setIf("descriptionAr", patch.descriptionAr);
  setIf("brand", patch.brand);
  setIf("images", patch.images);
  setIf("slug", patch.slug);
  setIf("isActive", patch.isActive);

  if (patch.categoryIds !== undefined) prod.categoryIds = (patch.categoryIds || []).map(oid);
  if (patch.attributes !== undefined) prod.attributes = patch.attributes || {};

  await prod.save();
  return prod;
}

export async function softDeleteProduct(productId) {
  const prod = await Product.findOne({ _id: productId, isDeleted: { $ne: true } });
  if (!prod) {
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }
  prod.isActive = false;
  prod.isDeleted = true;
  prod.deletedAt = new Date();
  await prod.save();
  return prod;
}

export async function listProductsPublic(query) {
  const { page, limit, skip } = parsePagination(query, { maxLimit: 50, defaultLimit: 20 });

  const onlyActive = query.includeInactive ? false : true;

  const q = {};
  if (onlyActive) q.isActive = true;
  q.isDeleted = { $ne: true };

  if (query.brand) q.brand = String(query.brand).trim();

  let useTextSearch = false;
  if (query.q) {
    const raw = String(query.q).trim().slice(0, 64);
    if (raw.length >= 2) {
      q.$text = { $search: raw };
      useTextSearch = true;
    } else {
      const safe = escapeRegex(raw);
      q.$or = [
        { nameHe: { $regex: safe, $options: "i" } },
        { nameAr: { $regex: safe, $options: "i" } },
        { brand: { $regex: safe, $options: "i" } },
      ];
    }
  }

  if (query.categoryFullSlug) {
    const fullSlug = String(query.categoryFullSlug).trim();
    const cachedIds = getCategorySlugCache(fullSlug);
    if (cachedIds) {
      q.categoryIds = { $in: cachedIds };
    } else {
      const catQuery = Category.findOne(
        { fullSlug, isDeleted: { $ne: true } },
        { _id: 1 },
      ).lean();
      const cat = await applyQueryBudget(catQuery);

      if (cat) {
        const descendantsQuery = Category.find(
          { ancestors: cat._id, isDeleted: { $ne: true } },
          { _id: 1 },
        ).lean();
        const descendants = await applyQueryBudget(descendantsQuery);
        const ids = [cat._id, ...descendants.map((d) => d._id)];
        setCategorySlugCache(fullSlug, ids);
        q.categoryIds = { $in: ids };
      } else {
        return { items: [], page, limit, total: 0 };
      }
    }
  }

  const projection = {
    nameHe: 1,
    nameAr: 1,
    descriptionHe: 1,
    descriptionAr: 1,
    brand: 1,
    categoryIds: 1,
    images: 1,
    slug: 1,
    isActive: 1,

    // ✅ IMPORTANT: include product-level inStock
    inStock: 1,
    reviewsCount: 1,
    ratingAvg: 1,

    createdAt: 1,
    updatedAt: 1,
  };

  if (useTextSearch) {
    projection.score = { $meta: "textScore" };
  }

  const sortKey = String(query.sort || "new");
  const total = await applyQueryBudget(Product.countDocuments(q));

  const sortPopular = useTextSearch
    ? { score: { $meta: "textScore" }, reviewsCount: -1, ratingAvg: -1, createdAt: -1 }
    : { reviewsCount: -1, ratingAvg: -1, createdAt: -1 };

  const sortNewest = useTextSearch
    ? { score: { $meta: "textScore" }, createdAt: -1 }
    : { createdAt: -1 };

  const sort = sortKey === "popular" ? sortPopular : sortNewest;

  const itemsQuery = Product.find(q, projection).sort(sort).skip(skip).limit(limit).lean();
  const items = await applyQueryBudget(itemsQuery);

  // Variant summary: min price + inStock per product
  const ids = items.map((p) => p._id);

  const variants = ids.length
    ? await applyQueryBudget(
        Variant.find({ productId: { $in: ids }, isActive: true, isDeleted: { $ne: true } })
          .select("productId price currency available stock stockReserved")
          .lean(),
      )
    : [];

  /**
   * pid -> { minPrice, currency, anyVariantAvailable }
   * Note: product-level inStock will be applied later as a gate.
   */
  const variantSummary = new Map();
  for (const v of variants) {
    const pid = String(v.productId);
    const available = resolveVariantAvailable(v);

    const entry =
      variantSummary.get(pid) || {
        minPrice: null,
        currency: v.currency || "₪",
        anyVariantAvailable: false,
      };

    if (entry.minPrice === null || Number(v.price) < entry.minPrice) {
      entry.minPrice = Number(v.price);
    }

    if (available > 0) entry.anyVariantAvailable = true;

    if (!entry.currency) entry.currency = v.currency || "₪";

    variantSummary.set(pid, entry);
  }

  const out = items.map((p) => {
    const pid = String(p._id);

    const s = variantSummary.get(pid) || {
      minPrice: null,
      currency: "₪",
      anyVariantAvailable: false,
    };

    const r = {
      reviewsCount: p.reviewsCount || 0,
      ratingAvg: p.ratingAvg ?? null,
    };

    // ✅ FINAL inStock:
    // product-level inStock gates availability. If product.inStock=false => false no matter what variants say.
    // If product.inStock=true/undefined => depends on variants availability
    const finalInStock = typeof p.inStock === "boolean" ? p.inStock : s.anyVariantAvailable;
    const priceFrom = s.minPrice === null ? null : toMajorUnits(s.minPrice, s.currency);

    return {
      ...p,
      priceFrom,
      currency: s.currency,
      inStock: finalInStock,

      reviewsCount: r.reviewsCount || 0,
      ratingAvg: r.ratingAvg === null || r.ratingAvg === undefined ? null : Number(Number(r.ratingAvg).toFixed(2)),
    };
  });

  return { items: out, page, limit, total };
}

export async function getProductPublic(productId) {
  const prodQuery = Product.findOne({ _id: productId, isDeleted: { $ne: true } }).lean();
  const prod = await applyQueryBudget(prodQuery);
  if (!prod || !prod.isActive) {
    const err = new Error("PRODUCT_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const variantsQuery = Variant.find({
    productId: prod._id,
    isActive: true,
    isDeleted: { $ne: true },
  })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();
  const variants = await applyQueryBudget(variantsQuery);

  return { product: prod, variants };
}
