// src/services/home.service.js

import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Offer } from "../models/Offer.js";
import { HomeLayout } from "../models/HomeLayout.js";
import { t } from "../utils/i18n.js";
import {
  getFeaturedProducts,
  getNewArrivals,
  getBestSellers,
} from "./ranking-queries.service.js";

/**
 * ✅ Sale rule (Prompt enforced):
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

function normalizeImages(p) {
  const images = Array.isArray(p?.images) ? p.images.filter(Boolean) : [];
  const imageUrl = p?.imageUrl || images[0] || "";
  return { images, imageUrl };
}

/**
 * ✅ IMPORTANT:
 * - No more isFeatured/isBestSeller flags as source of truth.
 * - If you want additive compatibility, we can expose booleans
 *   derived from the section context (featured/best sellers).
 */
function mapProduct(p, lang, now) {
  const onSale = isSaleActiveByPrice(p, now);
  const { images, imageUrl } = normalizeImages(p);

  return {
    id: p._id,
    _id: p._id, // additive compatibility

    // ✅ Unified localized fields
    title: t(p, "title", lang),
    description: t(p, "description", lang),

    // ✅ Additive bilingual (safe)
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    descriptionHe: p.descriptionHe || p.description || "",
    descriptionAr: p.descriptionAr || "",

    slug: p.slug || "",

    price: Number(p.price || 0),
    stock: Number(p.stock || 0),
    categoryId: p.categoryId || null,

    // ✅ images
    imageUrl,
    images,

    // ✅ optional product info for tiles
    brand: p.brand ?? null,
    sizeLabel: p.sizeLabel ?? null,
    unit: p.unit ?? null,
    netQuantity: p.netQuantity ?? null,

    // ✅ extra info (store fields)
    ingredients: p.ingredients || "",
    usage: p.usage || "",
    warnings: p.warnings || "",
    manufacturerName: p.manufacturerName || "",
    importerName: p.importerName || "",
    countryOfOrigin: p.countryOfOrigin || "",
    warrantyInfo: p.warrantyInfo || "",

    // ✅ sale only if active by rule
    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,
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
    imageUrl: c.imageUrl || "",
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

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function pickHeroSectionPayload(layoutDoc) {
  const sections = Array.isArray(layoutDoc?.sections) ? layoutDoc.sections : [];

  const heroSection = sections
    .filter((section) => section?.type === "hero" && section?.enabled !== false)
    .sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))[0];

  const payload = heroSection?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const hero = {
    titleHe: normalizeText(payload.titleHe),
    titleAr: normalizeText(payload.titleAr),
    subtitleHe: normalizeText(payload.subtitleHe),
    subtitleAr: normalizeText(payload.subtitleAr),
    ctaTextHe: normalizeText(payload.ctaTextHe),
    ctaTextAr: normalizeText(payload.ctaTextAr),
    ctaLink: normalizeText(payload.ctaLink),
    imageUrl: normalizeText(payload.imageUrl),
    videoUrl: normalizeText(payload.videoUrl),
    videoPosterUrl: normalizeText(payload.videoPosterUrl || payload.posterUrl || payload.imageUrl),
  };

  const hasAnyContent = Object.values(hero).some(Boolean);
  return hasAnyContent ? hero : null;
}

/**
 * Only show "available enough" products:
 * - No variants → stock > 0
 * - Has variants → any variant stock > 0
 */
function availabilityFilter() {
  return {
    $or: [
      { "variants.0": { $exists: false }, stock: { $gt: 0 } },
      { "variants.stock": { $gt: 0 } },
    ],
  };
}

export async function getHomeData(lang) {
  const now = new Date();

  // ✅ home limits (fast + stable)
  const HOME_LIMIT = 12;
  const baseProductFilter = { isActive: true };

  // ✅ Small selects = faster home response
  // (include what Home/Shop cards need)
  const productSelect =
    "_id titleHe titleAr title descriptionHe descriptionAr description slug price salePrice discountPercent saleStartAt saleEndAt stock categoryId imageUrl images brand sizeLabel unit netQuantity ingredients usage warnings manufacturerName importerName countryOfOrigin warrantyInfo createdAt updatedAt";

  const categorySelect = "_id nameHe nameAr name slug imageUrl";
  const offerSelect = "_id type nameHe nameAr name value minTotal startAt endAt priority createdAt isActive";

  const [
    categories,
    rankedFeatured,
    rankedNewArrivals,
    rankedBestSellers,
    onSaleProducts,
    activeOffers,
    homeLayout,
  ] = await Promise.all([
    // ✅ categories
    Category.find({})
      .sort({ nameHe: 1 })
      .limit(50)
      .select(categorySelect)
      .lean(),

    // ✅ Featured (Server-side ranking list)
    safeRankingFetch(() =>
      getFeaturedProducts({ page: 1, limit: HOME_LIMIT, lang })
    ),

    // ✅ New arrivals (Server-side ranking list)
    safeRankingFetch(() =>
      getNewArrivals({ page: 1, limit: HOME_LIMIT, lang })
    ),

    // ✅ Best sellers (Server-side ranking list)
    safeRankingFetch(() =>
      getBestSellers({ page: 1, limit: HOME_LIMIT, lang })
    ),

    /**
     * ✅ onSale rule + date window
     * salePrice exists AND salePrice < price AND within (saleStartAt/saleEndAt if any)
     */
    Product.find({
      ...baseProductFilter,
      ...availabilityFilter(),
      salePrice: { $ne: null },
      $expr: { $lt: ["$salePrice", "$price"] },
      $and: [
        { $or: [{ saleStartAt: null }, { saleStartAt: { $lte: now } }] },
        { $or: [{ saleEndAt: null }, { saleEndAt: { $gte: now } }] },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(HOME_LIMIT)
      .select(productSelect)
      .lean(),

    /**
     * ✅ active offers within date range
     * priority DESC (higher first)
     */
    Offer.find({
      isActive: true,
      $and: [
        { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
        { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      ],
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select(offerSelect)
      .lean(),

    HomeLayout.findOne().select("sections").lean(),
  ]);

  // ✅ Extract ranked items safely
  const featuredItems = Array.isArray(rankedFeatured?.items) ? rankedFeatured.items : [];
  const newItems = Array.isArray(rankedNewArrivals?.items) ? rankedNewArrivals.items : [];
  const bestItems = Array.isArray(rankedBestSellers?.items) ? rankedBestSellers.items : [];

  /**
   * ✅ HARD FALLBACKS (important):
   * If ranking system is empty/not ready, we fallback to "newest"
   * so Home never breaks.
   */
  const fallbackNewest = await Product.find({
    ...baseProductFilter,
    ...availabilityFilter(),
  })
    .sort({ createdAt: -1 })
    .limit(HOME_LIMIT)
    .select(productSelect)
    .lean();

  const finalFeatured = featuredItems.length ? featuredItems : fallbackNewest;
  const finalNewArrivals = newItems.length ? newItems : fallbackNewest;
  const finalBestSellers = bestItems.length ? bestItems : fallbackNewest;
  const hero = pickHeroSectionPayload(homeLayout);

  return {
    categories: (categories || []).map((c) => mapCategory(c, lang)),

    // ✅ server-side ranking lists (automatic)
    featuredProducts: finalFeatured.map((p) => mapProduct(p, lang, now)),
    newProducts: finalNewArrivals.map((p) => mapProduct(p, lang, now)),
    bestSellers: finalBestSellers.map((p) => mapProduct(p, lang, now)),

    // ✅ price-based sale (rule enforced)
    onSale: (onSaleProducts || []).map((p) => mapProduct(p, lang, now)),

    activeOffers: (activeOffers || []).map((o) => mapOffer(o, lang)),
    hero,
  };
}

/**
 * ✅ Ranking fetch safety:
 * Ranking jobs might be disabled or not ready on fresh DB.
 * This prevents Home from failing hard.
 */
async function safeRankingFetch(fn) {
  try {
    const res = await fn();
    if (!res || typeof res !== "object") return { items: [], meta: null };
    const items = Array.isArray(res.items) ? res.items : [];
    const meta = res.meta ?? null;
    return { items, meta };
  } catch {
    return { items: [], meta: null };
  }
}
