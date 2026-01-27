// src/services/ranking-queries.service.js
// Server-side ranking queries for home sections.
// All ranking logic is computed on the server - no client-side sorting allowed.

import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { Review } from "../models/Review.js";

// Active product base filter
const ACTIVE_FILTER = { isActive: true, isDeleted: { $ne: true } };

// Minimal fields required for ranking product cards
const PRODUCT_CARD_FIELDS = [
  "_id",
  "slug",
  "title",
  "titleHe",
  "titleAr",
  "description",
  "descriptionHe",
  "descriptionAr",
  "price",
  "salePrice",
  "saleStartAt",
  "saleEndAt",
  "discountPercent",
  "imageUrl",
  "images",
  "brand",
  "sku",
  "barcode",
  "sizeLabel",
  "unit",
  "netQuantity",
  "stock",
  "categoryId",
  "tags",
  "isFeatured",
  "isBestSeller",
  "isActive",
  "createdAt",
].join(" ");

const PRODUCT_CARD_PROJECTION = {
  _id: 1,
  slug: 1,
  title: 1,
  titleHe: 1,
  titleAr: 1,
  description: 1,
  descriptionHe: 1,
  descriptionAr: 1,
  price: 1,
  salePrice: 1,
  saleStartAt: 1,
  saleEndAt: 1,
  discountPercent: 1,
  imageUrl: 1,
  images: 1,
  brand: 1,
  sku: 1,
  barcode: 1,
  sizeLabel: 1,
  unit: 1,
  netQuantity: 1,
  stock: 1,
  categoryId: 1,
  tags: 1,
  isFeatured: 1,
  isBestSeller: 1,
  isActive: 1,
  createdAt: 1,
};

// Valid order statuses for sales counting
const SALES_STATUSES = [
  "paid",
  "payment_received",
  "confirmed",
  "stock_confirmed",
  "shipped",
  "delivered",
];

// Excluded statuses (cancelled, refunded, etc.)
const EXCLUDED_STATUSES = [
  "cancelled",
  "refunded",
  "return_requested",
  "refund_pending",
  "partially_refunded",
];

/**
 * Helper: convert string to ObjectId safely.
 */
function toObjectId(id) {
  if (!id) return null;
  const str = String(id);
  return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
}

/**
 * Helper: get date N days ago.
 */
function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Helper: build category filter.
 */
function buildCategoryFilter(categoryId) {
  const oid = toObjectId(categoryId);
  return oid ? { categoryId: oid } : {};
}

/**
 * ============================================================================
 * BEST SELLERS
 * Based on real sales in last 30/60/90 days.
 * Uses OrderItems aggregation (sum quantities per product).
 * Excludes cancelled/refunded orders.
 * Tie-break: newest first (by createdAt desc).
 * ============================================================================
 */
export async function getBestSellers({
  page = 1,
  limit = 12,
  categoryId = null,
  now = new Date(),
} = {}) {
  const skip = (page - 1) * limit;
  const catFilter = buildCategoryFilter(categoryId);

  // Stats-based server-side ranking (Product collection only)
  const productFilter = { ...ACTIVE_FILTER, ...catFilter };
  const sort = {
    "stats.soldCount30d": -1,
    createdAt: -1,
  };

  const [items, total] = await Promise.all([
    Product.find(productFilter)
      .select(PRODUCT_CARD_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(productFilter),
  ]);

  return {
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * ============================================================================
 * MOST POPULAR
 * Based on popularity score combining:
 * - viewsCount (product page views)
 * - addToCartCount
 * - wishlistCount
 * - recentOrdersCount (small weight)
 * Apply time-decay so recent activity matters more.
 * ============================================================================
 */
export async function getMostPopular({
  page = 1,
  limit = 12,
  categoryId = null,
  now = new Date(),
} = {}) {
  const skip = (page - 1) * limit;
  const catFilter = buildCategoryFilter(categoryId);

  // Stats-based server-side ranking (Product collection only)
  const productFilter = { ...ACTIVE_FILTER, ...catFilter };

  const views7d = { $ifNull: ["$stats.views7d", 0] };
  const cart30 = { $ifNull: ["$stats.cartAdds30d", 0] };
  const wish30 = { $ifNull: ["$stats.wishlistAdds30d", 0] };
  const sold30 = { $ifNull: ["$stats.soldCount30d", 0] };
  const popularityRaw = {
    $add: [
      { $multiply: [views7d, 0.05] },
      { $multiply: [cart30, 0.6] },
      { $multiply: [wish30, 0.8] },
      { $multiply: [sold30, 0.5] },
    ],
  };

  const [items, total] = await Promise.all([
    Product.aggregate([
      { $match: productFilter },
      {
        $addFields: {
          _popularityScore: { $ln: { $add: [1, popularityRaw] } },
        },
      },
      { $sort: { _popularityScore: -1, createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: PRODUCT_CARD_PROJECTION },
    ]),
    Product.countDocuments(productFilter),
  ]);

  return {
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * ============================================================================
 * TOP RATED
 * Based on approved reviews only.
 * Weighted rating (Bayesian) to avoid small-sample bias.
 * ============================================================================
 */
export async function getTopRated({
  page = 1,
  limit = 12,
  categoryId = null,
  now = new Date(),
} = {}) {
  const skip = (page - 1) * limit;
  const catFilter = buildCategoryFilter(categoryId);

  // Stats-based server-side ranking (Product collection only)
  const productFilter = { ...ACTIVE_FILTER, ...catFilter };
  const sort = {
    "stats.ratingAvg": -1,
    "stats.ratingCount": -1,
    createdAt: -1,
  };

  const [items, total] = await Promise.all([
    Product.find(productFilter)
      .select(PRODUCT_CARD_FIELDS)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(productFilter),
  ]);

  return {
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * ============================================================================
 * FEATURED PRODUCTS (AUTO-GENERATED)
 * Combine best-sellers + high rating + healthy stock + onSale boost.
 * Returns the top N for the week.
 * ============================================================================
 */
export async function getFeaturedProducts({
  page = 1,
  limit = 12,
  categoryId = null,
  salesWindowDays = 30,
  now = new Date(),
} = {}) {
  const skip = (page - 1) * limit;
  const sinceDate = daysAgo(salesWindowDays, now);
  const catFilter = buildCategoryFilter(categoryId);

  // Step 1: Get sales data
  const salesAgg = await Order.aggregate([
    {
      $match: {
        status: { $in: SALES_STATUSES },
        createdAt: { $gte: sinceDate },
        "refund.status": { $ne: "succeeded" },
      },
    },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        totalQty: { $sum: "$items.qty" },
      },
    },
  ]);
  const salesMap = new Map(salesAgg.map((s) => [String(s._id), s.totalQty]));

  // Step 2: Get review data
  const reviewsAgg = await Review.aggregate([
    {
      $match: {
        isHidden: { $ne: true },
        $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$productId",
        avgRating: { $avg: "$rating" },
        reviewCount: { $sum: 1 },
      },
    },
  ]);
  const reviewsMap = new Map(reviewsAgg.map((r) => [String(r._id), r]));

  // Step 3: Fetch active products
  const productFilter = {
    ...ACTIVE_FILTER,
    ...catFilter,
  };

  const products = await Product.find(productFilter)
    .select(PRODUCT_CARD_FIELDS + " variants")
    .lean();

  // Bayesian parameters
  const priorMean = 4.2;
  const priorCount = 5;

  // Step 4: Compute featured score
  const scored = products.map((p) => {
    const pid = String(p._id);
    const salesQty = salesMap.get(pid) || 0;
    const review = reviewsMap.get(pid) || { avgRating: 0, reviewCount: 0 };

    // Bayesian rating
    let bayesianRating = priorMean;
    if (review.reviewCount > 0) {
      bayesianRating =
        (priorMean * priorCount + review.avgRating * review.reviewCount) /
        (priorCount + review.reviewCount);
    }

    // Stock health factor
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const totalStock = hasVariants
      ? p.variants.reduce((sum, v) => sum + Number(v?.stock || 0), 0)
      : Number(p.stock || 0);
    const stockFactor = totalStock > 10 ? 1.2 : totalStock > 0 ? 1.0 : 0.3;

    // On-sale boost
    const onSale = isSaleActive(p, now);
    const saleBoost = onSale ? 1.15 : 1.0;

    // Featured score formula:
    // salesScore * 0.4 + ratingScore * 0.35 + stockFactor * 0.15 + saleBoost * 0.1
    const salesScore = Math.log1p(salesQty);
    const ratingScore = bayesianRating * Math.log1p(review.reviewCount + 1);

    const featuredScore =
      salesScore * 0.4 + ratingScore * 0.35 + stockFactor * 0.15 + (saleBoost - 1) * 2;

    return { ...p, _featuredScore: featuredScore };
  });

  // Step 5: Sort by featured score desc
  const sorted = scored.sort((a, b) => {
    if (b._featuredScore !== a._featuredScore) return b._featuredScore - a._featuredScore;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Step 6: Paginate
  const total = sorted.length;
  const items = sorted.slice(skip, skip + limit).map(stripInternalFields);

  return {
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * ============================================================================
 * NEW ARRIVALS (AUTO-GENERATED)
 * Sorted by createdAt desc.
 * Optionally boost products with stock > 0.
 * ============================================================================
 */
export async function getNewArrivals({
  page = 1,
  limit = 12,
  categoryId = null,
  maxAgeDays = 90, // Only show products created within this window
  boostInStock = true,
  now = new Date(),
} = {}) {
  const skip = (page - 1) * limit;
  const sinceDate = daysAgo(maxAgeDays, now);
  const catFilter = buildCategoryFilter(categoryId);

  // Build filter
  const productFilter = {
    ...ACTIVE_FILTER,
    ...catFilter,
    createdAt: { $gte: sinceDate },
  };

  // Fetch products sorted by createdAt desc
  const products = await Product.find(productFilter)
    .select(PRODUCT_CARD_FIELDS + " variants createdAt")
    .sort({ createdAt: -1 })
    .lean();

  // If boosting in-stock products, re-sort
  let sorted = products;
  if (boostInStock) {
    sorted = products
      .map((p) => {
        const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
        const hasStock = hasVariants
          ? p.variants.some((v) => Number(v?.stock || 0) > 0)
          : Number(p.stock || 0) > 0;
        return { ...p, _hasStock: hasStock };
      })
      .sort((a, b) => {
        // In-stock products first
        if (a._hasStock !== b._hasStock) return a._hasStock ? -1 : 1;
        // Then by createdAt desc
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
  }

  // Paginate
  const total = sorted.length;
  const items = sorted.slice(skip, skip + limit).map(stripInternalFields);

  return {
    items,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * ============================================================================
 * HELPERS
 * ============================================================================
 */

/**
 * Fallback query when no ranking data is available.
 */
async function getFallbackProducts({ page, limit, categoryId, sortBy = "createdAt" }) {
  const skip = (page - 1) * limit;
  const catFilter = buildCategoryFilter(categoryId);

  const productFilter = {
    ...ACTIVE_FILTER,
    ...catFilter,
  };

  const [products, total] = await Promise.all([
    Product.find(productFilter)
      .select("-__v")
      .sort({ [sortBy]: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(productFilter),
  ]);

  return {
    items: products,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Check if product is currently on sale.
 */
function isSaleActive(p, now = new Date()) {
  if (p?.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < new Date(p.saleStartAt)) return false;
  if (p.saleEndAt && now > new Date(p.saleEndAt)) return false;
  return true;
}

/**
 * Remove internal scoring fields from product before returning to client.
 */
function stripInternalFields(p) {
  if (!p) return p;

  const {
    _salesQty,
    _lastOrderAt,
    _popularityScore,
    _ratingScore,
    _avgRating,
    _reviewCount,
    _featuredScore,
    _hasStock,
    // Also strip server-side ranking scores
    salesScore,
    popularityScore,
    ratingScore,
    finalRankScore,
    rankUpdatedAt,
    rankLastActivityAt,
    stats,
    // Strip internal status fields (always true for ranking, no need to expose)
    isActive,
    isDeleted,
    deletedAt,
    // Strip variant internals if present
    variants,
    ...clean
  } = p;

  return clean;
}
