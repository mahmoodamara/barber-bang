// src/services/home.service.js

import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Offer } from "../models/Offer.js";
import { t } from "../utils/i18n.js";

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

function mapProduct(p, lang, now) {
  const onSale = isSaleActiveByPrice(p, now);

  return {
    id: p._id,
    _id: p._id, // additive compatibility

    // ✅ Unified fields
    title: t(p, "title", lang),
    description: t(p, "description", lang),

    // ✅ Additive bilingual (safe)
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    descriptionHe: p.descriptionHe || p.description || "",
    descriptionAr: p.descriptionAr || "",

    price: Number(p.price || 0),
    stock: Number(p.stock || 0),
    categoryId: p.categoryId || null,
    imageUrl: p.imageUrl || "",

    isFeatured: Boolean(p.isFeatured),
    isBestSeller: Boolean(p.isBestSeller),

    // ✅ sale only if active by rule
    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,

          // optional additive badge info (frontend can ignore)
          discountPercent: p.discountPercent ?? null,
        }
      : null,
  };
}

function mapCategory(c, lang) {
  return {
    id: c._id,
    _id: c._id, // additive compatibility

    // ✅ Unified
    name: t(c, "name", lang),

    // ✅ Additive bilingual
    nameHe: c.nameHe || c.name || "",
    nameAr: c.nameAr || "",

    slug: c.slug || "",
  };
}

function mapOffer(o, lang) {
  return {
    id: o._id,
    _id: o._id, // additive compatibility

    type: o.type,

    // ✅ Unified name required by the prompt
    name: t(o, "name", lang),

    // ✅ Additive bilingual
    nameHe: o.nameHe || o.name || "",
    nameAr: o.nameAr || "",

    value: Number(o.value || 0),
    minTotal: Number(o.minTotal || 0),
    startAt: o.startAt || null,
    endAt: o.endAt || null,
  };
}

export async function getHomeData(lang) {
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const baseProductFilter = { isActive: true };

  // ✅ Small selects = faster home response
  const productSelect =
    "_id titleHe titleAr title descriptionHe descriptionAr description price salePrice discountPercent saleStartAt saleEndAt stock categoryId imageUrl isFeatured isBestSeller createdAt";

  const categorySelect = "_id nameHe nameAr name slug";
  const offerSelect = "_id type nameHe nameAr name value minTotal startAt endAt priority createdAt";

  const [
    categories,
    featuredProducts,
    newProductsRecent,
    newProductsFallback,
    bestSellers,
    onSaleProducts,
    activeOffers,
  ] = await Promise.all([
    // ✅ categories
    Category.find({})
      .sort({ nameHe: 1 })
      .limit(50)
      .select(categorySelect)
      .lean(),

    // ✅ featured
    Product.find({ ...baseProductFilter, isFeatured: true })
      .sort({ createdAt: -1 })
      .limit(12)
      .select(productSelect)
      .lean(),

    // ✅ new products (last 14 days)
    Product.find({ ...baseProductFilter, createdAt: { $gte: fourteenDaysAgo } })
      .sort({ createdAt: -1 })
      .limit(12)
      .select(productSelect)
      .lean(),

    // ✅ fallback newest products
    Product.find(baseProductFilter)
      .sort({ createdAt: -1 })
      .limit(12)
      .select(productSelect)
      .lean(),

    // ✅ best sellers
    Product.find({ ...baseProductFilter, isBestSeller: true })
      .sort({ createdAt: -1 })
      .limit(12)
      .select(productSelect)
      .lean(),

    /**
     * ✅ onSale rule + date window
     */
    Product.find({
      ...baseProductFilter,
      salePrice: { $ne: null },
      $expr: { $lt: ["$salePrice", "$price"] },
      $and: [
        { $or: [{ saleStartAt: null }, { saleStartAt: { $lte: now } }] },
        { $or: [{ saleEndAt: null }, { saleEndAt: { $gte: now } }] },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(12)
      .select(productSelect)
      .lean(),

    /**
     * ✅ active offers within date range
     */
    Offer.find({
      isActive: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      ],
    })
      .sort({ priority: 1, createdAt: -1 })
      .limit(20)
      .select(offerSelect)
      .lean(),
  ]);

  // ✅ prefer recent new products, fallback otherwise
  const newProducts = newProductsRecent.length > 0 ? newProductsRecent : newProductsFallback;

  return {
    categories: categories.map((c) => mapCategory(c, lang)),
    featuredProducts: featuredProducts.map((p) => mapProduct(p, lang, now)),
    newProducts: newProducts.map((p) => mapProduct(p, lang, now)),
    bestSellers: bestSellers.map((p) => mapProduct(p, lang, now)),
    onSale: onSaleProducts.map((p) => mapProduct(p, lang, now)),
    activeOffers: activeOffers.map((o) => mapOffer(o, lang)),
  };
}
