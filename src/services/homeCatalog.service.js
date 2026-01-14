// src/services/homeCatalog.service.js
import { Category, Product, Review, Order } from "../models/index.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

const PAIDISH = ["stock_confirmed", "paid", "fulfilled", "partially_refunded", "refunded"];

export async function listHomeCategories({ onlyActive = true, topLevel = true } = {}) {
  const q = onlyActive ? { isActive: true } : {};
  q.isDeleted = { $ne: true };
  if (topLevel) q.parentId = null;

  const catsQuery = Category.find(q)
    .select("_id slug fullSlug nameHe nameAr image sortOrder parentId level isActive createdAt")
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();
  const cats = await applyQueryBudget(catsQuery);

  if (!cats.length) return [];

  const catIds = cats.map((c) => c._id);
  const catIdSet = new Set(catIds.map((id) => String(id)));

  const relevantCats = topLevel
    ? await applyQueryBudget(
        Category.find({
          $or: [{ _id: { $in: catIds } }, { ancestors: { $in: catIds } }],
          isDeleted: { $ne: true },
        })
          .select("_id ancestors")
          .lean(),
      )
    : cats.map((c) => ({ _id: c._id, ancestors: c.ancestors ?? [] }));

  const relevantCatIds = relevantCats.map((c) => c._id);

  const countsAgg = await applyQueryBudget(
    Product.aggregate([
      {
        $match: { isActive: true, isDeleted: { $ne: true }, categoryIds: { $in: relevantCatIds } },
      },
      { $unwind: "$categoryIds" },
      { $match: { categoryIds: { $in: relevantCatIds } } },
      { $group: { _id: "$categoryIds", count: { $sum: 1 } } },
    ]),
  );

  const countsByCategory = new Map(countsAgg.map((x) => [String(x._id), x.count]));
  const counts = new Map();

  if (topLevel) {
    const topIdByCatId = new Map();
    for (const c of relevantCats) {
      const id = String(c._id);
      let topId = catIdSet.has(id) ? id : null;
      if (!topId && Array.isArray(c.ancestors)) {
        for (const anc of c.ancestors) {
          const ancId = String(anc);
          if (catIdSet.has(ancId)) {
            topId = ancId;
            break;
          }
        }
      }
      if (topId) topIdByCatId.set(id, topId);
    }

    for (const id of catIdSet) counts.set(id, 0);

    for (const [catId, count] of countsByCategory.entries()) {
      const topId = topIdByCatId.get(catId);
      if (!topId) continue;
      counts.set(topId, (counts.get(topId) || 0) + count);
    }
  } else {
    for (const [catId, count] of countsByCategory.entries()) {
      counts.set(catId, count);
    }
  }

  const imagesAgg = await applyQueryBudget(
    Product.aggregate([
      {
        $match: {
          isActive: true,
          isDeleted: { $ne: true },
          categoryIds: { $in: catIds },
          images: { $exists: true, $ne: [] },
        },
      },
      { $unwind: "$categoryIds" },
      { $match: { categoryIds: { $in: catIds } } },
      { $project: { categoryId: "$categoryIds", image: { $arrayElemAt: ["$images", 0] } } },
      { $match: { image: { $type: "string", $ne: "" } } },
      { $group: { _id: "$categoryId", image: { $first: "$image" } } },
    ]),
  );

  const images = new Map(imagesAgg.map((x) => [String(x._id), x.image]));

  return cats.map((c) => ({
    id: String(c._id),
    slug: c.slug,
    fullSlug: c.fullSlug,
    nameHe: c.nameHe,
    nameAr: c.nameAr,
    image: (c.image && String(c.image).trim()) || images.get(String(c._id)) || "",
    productsCount: counts.get(String(c._id)) || 0,
  }));
}

export async function listBrandsPublic({ onlyActive = true, limit = 100 } = {}) {
  const q = {};
  if (onlyActive) q.isActive = true;
  q.isDeleted = { $ne: true };

  const brands = await applyQueryBudget(Product.distinct("brand", q));
  const cleaned = brands
    .map((b) => (b === null || b === undefined ? "" : String(b).trim()))
    .filter(Boolean);

  cleaned.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  return cleaned.slice(0, Math.max(1, Math.min(500, Number(limit || 100))));
}

export async function getCatalogStats() {
  const [reviewAgg, ordersCount, customersAgg] = await Promise.all([
    applyQueryBudget(
      Review.aggregate([
        { $match: { status: "approved", isDeleted: false } },
        { $group: { _id: null, ratingAvg: { $avg: "$rating" }, reviewsCount: { $sum: 1 } } },
      ]),
    ),
    applyQueryBudget(Order.countDocuments({ status: { $in: PAIDISH } })),
    applyQueryBudget(
      Order.aggregate([
        { $match: { status: { $in: PAIDISH }, userId: { $exists: true, $nin: [null, ""] } } },
        { $group: { _id: "$userId" } },
        { $count: "customersCount" },
      ]),
    ),
  ]);

  const ratingAvgRaw = reviewAgg?.[0]?.ratingAvg;
  const ratingAvg = ratingAvgRaw ? Number(Number(ratingAvgRaw).toFixed(2)) : null;

  return {
    ratingAvg,
    reviewsCount: reviewAgg?.[0]?.reviewsCount || 0,
    ordersCount: ordersCount || 0,
    customersCount: customersAgg?.[0]?.customersCount || 0,
    shippingLabel: "24–72h",
  };
}

export async function listFeaturedReviewsPublic({ lang, limit = 3 } = {}) {
  const lim = Math.max(1, Math.min(20, Number(limit || 3)));
  const base = { status: "approved", isDeleted: false };
  if (lang) base.lang = lang;

  let featured = [];
  try {
    featured = await applyQueryBudget(
      Review.find({ ...base, isFeatured: true })
        .select("rating title body lang verifiedPurchase createdAt")
        .sort({ createdAt: -1 })
        .limit(lim)
        .lean(),
    );
  } catch {
    featured = [];
  }

  const missing = lim - featured.length;
  let filler = [];
  if (missing > 0) {
    const excludeIds = featured.map((x) => x._id);
    filler = await applyQueryBudget(
      Review.find({ ...base, _id: { $nin: excludeIds } })
        .select("rating title body lang verifiedPurchase createdAt")
        .sort({ rating: -1, createdAt: -1 })
        .limit(missing)
        .lean(),
    );
  }

  return [...featured, ...filler].map((r) => ({
    id: String(r._id),
    rating: r.rating,
    title: r.title || "",
    body: r.body || "",
    lang: r.lang,
    verifiedPurchase: !!r.verifiedPurchase,
    createdAt: r.createdAt,
  }));
}
