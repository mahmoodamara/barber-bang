import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { getLang, localizeCategory, localizeProduct } from "../utils/lang.js";
import { mapMoneyPairFromMajor, mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { listCategoriesTree as listCategoriesTreeSvc } from "../services/category.service.js";
import { listProductsPublic, getProductPublic } from "../services/product.service.js";
import {
  listHomeCategories,
  listBrandsPublic,
  getCatalogStats,
  listFeaturedReviewsPublic,
} from "../services/homeCatalog.service.js";

/**
 * ✅ Robust availability resolver.
 * Priority:
 * 1) Product.inStock === false (explicit override)
 * 2) derived from known numeric fields (available/stock/totalAvailable/etc.)
 * 3) derived from variants array if present
 * 4) default true (UX-safe when backend lacks data)
 */
function resolveInStock(p, variantsMaybe) {
  if (typeof p?.inStock === "boolean") return p.inStock;

  // direct numeric hints
  const directQtyCandidates = [
    p?.available,
    p?.stock,
    p?.stockAvailable,
    p?.totalAvailable,
    p?.availableTotal,
    p?.variantsAvailable,
  ];
  for (const v of directQtyCandidates) {
    if (typeof v === "number" && Number.isFinite(v)) return v > 0;
  }

  // derive from variants
  const vars = Array.isArray(variantsMaybe)
    ? variantsMaybe
    : Array.isArray(p?.variants)
      ? p.variants
      : null;
  if (vars && vars.length) {
    const anyAvail = vars.some((v) => {
      const av =
        typeof v?.available === "number"
          ? v.available
          : typeof v?.stock === "number"
            ? Math.max(0, (v.stock || 0) - (v.stockReserved || 0))
            : 0;
      return av > 0;
    });
    return anyAvail;
  }

  return true;
}

function unwrapItems(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return Array.isArray(result.items) ? result.items : [];
}

export async function listCategoriesTree(req, res) {
  const lang = getLang(req);
  const tree = await listCategoriesTreeSvc({ onlyActive: true });

  const mapNode = (n) => ({
    ...localizeCategory({ ...n, id: n._id?.toString?.() || n.id }, lang),
    children: (n.children || []).map(mapNode),
  });

  res.json({ ok: true, lang, tree: tree.map(mapNode) });
}

export async function listCategories(req, res) {
  const lang = getLang(req);
  const topLevel = !(req.query.topLevel === "0" || req.query.topLevel === "false");

  const items = await listHomeCategories({ onlyActive: true, topLevel });

  res.json({
    ok: true,
    lang,
    items: items.map((c) => ({
      ...localizeCategory(
        {
          id: c.id,
          nameHe: c.nameHe,
          nameAr: c.nameAr,
          slug: c.slug,
          fullSlug: c.fullSlug,
          parentId: null,
          ancestors: [],
          level: 0,
          sortOrder: 0,
          isActive: true,
        },
        lang,
      ),
      image: c.image,
      productsCount: c.productsCount,
    })),
  });
}

export async function listBrands(req, res) {
  const lang = getLang(req);
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const items = await listBrandsPublic({ onlyActive: true, limit });

  res.json({ ok: true, lang, items });
}

export async function catalogStats(req, res) {
  const lang = getLang(req);
  const stats = await getCatalogStats();
  res.json({ ok: true, lang, ...stats });
}

export async function homePayload(req, res) {
  const lang = getLang(req);

  const productsLimit = req.query.productsLimit ? Number(req.query.productsLimit) : 6;
  const reviewsLimit = req.query.reviewsLimit ? Number(req.query.reviewsLimit) : 3;

  const [categories, brands, stats, reviews, popularResult] = await Promise.all([
    listHomeCategories({ onlyActive: true, topLevel: true }),
    listBrandsPublic({ onlyActive: true, limit: 100 }),
    getCatalogStats(),
    listFeaturedReviewsPublic({ lang, limit: reviewsLimit }),
    listProductsPublic({ sort: "popular", page: 1, limit: productsLimit }),
  ]);

  const popularItems = unwrapItems(popularResult);

  res.json({
    ok: true,
    lang,
    stats,

    // keep as-is for front flexibility
    brands,

    categories: categories.map((c) => ({
      id: c.id,
      nameHe: c.nameHe,
      nameAr: c.nameAr,
      slug: c.slug,
      fullSlug: c.fullSlug,
      image: c.image,
      productsCount: c.productsCount,
    })),

    reviews,

    popular: popularItems.map((p) => {
      const id = p._id?.toString?.() || p.id;
      const localized = localizeProduct({ ...p, id }, lang);
      const currency = normalizeCurrency(p.currency);

      return {
        ...localized,
        _id: id,
        images: p.images || localized.images || [],
        ...mapMoneyPairFromMajor(p.priceFrom ?? p.price ?? null, currency, "price", "priceMinor"),
        currency,

        // ✅ FIX: stable inStock
        inStock: resolveInStock(p),

        ratingAvg: p.ratingAvg ?? null,
        reviewsCount: p.reviewsCount ?? 0,
      };
    }),
  });
}

export async function listProducts(req, res) {
  const lang = getLang(req);
  const q = req.validated?.query || req.query || {};
  const search = q.q || q.search;

  const result = await listProductsPublic({
    q: search,
    brand: q.brand,
    sort: q.sort,
    page: q.page,
    limit: q.limit,
    categoryFullSlug: q.category,
  });

  const items = unwrapItems(result);

  res.json({
    ok: true,
    lang,
    page: result.page,
    limit: result.limit,
    total: result.total,
    items: items.map((p) => {
      const id = p._id?.toString?.() || p.id;
      const currency = normalizeCurrency(p.currency);
      const pricePair = mapMoneyPairFromMajor(p.priceFrom ?? null, currency, "priceFrom", "priceFromMinor");
      return {
        ...localizeProduct({ ...p, id }, lang),
        ...pricePair,
        currency,

        // ✅ FIX: stable inStock (prefer stored boolean if exists)
        inStock: resolveInStock(p),

        ratingAvg: p.ratingAvg ?? null,
        reviewsCount: p.reviewsCount ?? 0,
      };
    }),
  });
}

export async function getProduct(req, res) {
  const lang = getLang(req);
  const idOrSlug = req.validated?.params?.idOrSlug || req.params.idOrSlug || req.params.id;
  const isObjectId = mongoose.Types.ObjectId.isValid(String(idOrSlug || ""));
  let productId = idOrSlug;

  if (!isObjectId) {
    const found = await applyQueryBudget(
      Product.findOne({ slug: String(idOrSlug).trim(), isDeleted: { $ne: true } })
        .select("_id")
        .lean(),
    );
    if (!found?._id) {
      const err = new Error("Product not found");
      err.statusCode = 404;
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }
    productId = found._id;
  }

  const { product, variants } = await getProductPublic(productId);

  const normalizedVariants = (variants || []).map((v) => {
    const available =
      typeof v?.available === "number"
        ? Math.max(0, v.available)
        : Math.max(0, (v.stock || 0) - (v.stockReserved || 0));
    const currency = normalizeCurrency(v.currency);

    return {
      id: String(v._id),
      productId: String(v.productId),
      sku: v.sku,
      barcode: v.barcode,
      ...mapMoneyPairFromMinor(v.price, currency, "price", "priceMinor"),
      currency,
      options: v.options || {},

      // ✅ FIX: respect available if present, otherwise compute
      available,

      isActive: v.isActive,
    };
  });

  const productIdStr = String(product._id);

  const productCurrency = normalizeCurrency(product.currency);

  res.json({
    ok: true,
    lang,
    product: {
      ...localizeProduct({ ...product, id: productIdStr }, lang),

      // ✅ IMPORTANT: make sure product response includes it
      inStock: resolveInStock(product, normalizedVariants),

      // optional helpful fields (safe)
      _id: productIdStr,
      ...mapMoneyPairFromMajor(
        product.priceFrom ?? product.price ?? null,
        productCurrency,
        "priceFrom",
        "priceFromMinor",
      ),
      currency: productCurrency,
    },
    variants: normalizedVariants,
  });
}
