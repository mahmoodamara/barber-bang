// src/services/pricing.service.js

import { Product } from "../models/Product.js";
import { Coupon } from "../models/Coupon.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { evaluateOffers } from "./offers.service.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";

/**
 * ============================
 * Money helpers (ILS Major <-> Minor)
 * ============================
 * We compute everything in minor units (agorot) to prevent float drift.
 */

function toMinor(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function fromMinor(minor) {
  const n = Number(minor || 0);
  if (!Number.isFinite(n)) return 0;
  // minor is integer (agorot). safest conversion:
  return Math.round(n) / 100;
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function isActiveByDates(doc, now = new Date()) {
  if (!doc?.isActive) return false;
  if (doc.startAt && now < doc.startAt) return false;
  if (doc.endAt && now > doc.endAt) return false;
  return true;
}

/**
 * ✅ Sale is ONLY active when:
 * - salePrice exists AND salePrice < price
 * - date window (if present) matches
 */
function productSaleActiveByPrice(p, now = new Date()) {
  if (p?.salePrice == null) return false;

  const price = Number(p.price || 0);
  const sale = Number(p.salePrice || 0);

  if (!Number.isFinite(price) || !Number.isFinite(sale)) return false;
  if (!(sale < price)) return false;

  if (p.saleStartAt && now < p.saleStartAt) return false;
  if (p.saleEndAt && now > p.saleEndAt) return false;

  return true;
}

function computeEffectiveUnitPriceMajor(p, now = new Date()) {
  const base = Number(p.price || 0);
  if (!Number.isFinite(base)) return 0;

  if (!productSaleActiveByPrice(p, now)) return Math.max(0, base);

  const sale = Number(p.salePrice || 0);
  if (!Number.isFinite(sale)) return Math.max(0, base);

  return Math.max(0, Math.min(base, sale));
}

function computePercentDiscountMinor(amountMinor, percent) {
  const pct = Math.max(0, Math.min(100, Number(percent)));
  if (!Number.isFinite(pct)) return 0;

  const disc = Math.round(Number(amountMinor || 0) * (pct / 100));
  return Math.max(0, disc);
}

/**
 * Shipping fee resolver
 * shipping = {
 *   mode: "DELIVERY" | "PICKUP_POINT" | "STORE_PICKUP",
 *   deliveryAreaId?,
 *   pickupPointId?
 * }
 */
async function resolveShippingFeeMinor(shipping) {
  const mode = shipping?.mode;

  if (!mode) throw makeErr(400, "MISSING_SHIPPING_MODE", "shipping.mode is required");

  if (mode === "DELIVERY") {
    if (!shipping?.deliveryAreaId) {
      throw makeErr(400, "MISSING_DELIVERY_AREA", "deliveryAreaId is required for DELIVERY");
    }

    const area = await DeliveryArea.findById(shipping.deliveryAreaId).lean();
    if (!area || !area.isActive) {
      throw makeErr(400, "INVALID_DELIVERY_AREA", "Delivery area not found");
    }

    return toMinor(area.fee || 0);
  }

  if (mode === "PICKUP_POINT") {
    if (!shipping?.pickupPointId) {
      throw makeErr(400, "MISSING_PICKUP_POINT", "pickupPointId is required for PICKUP_POINT");
    }

    const point = await PickupPoint.findById(shipping.pickupPointId).lean();
    if (!point || !point.isActive) {
      throw makeErr(400, "INVALID_PICKUP_POINT", "Pickup point not found");
    }

    return toMinor(point.fee || 0);
  }

  if (mode === "STORE_PICKUP") {
    const cfg = await StorePickupConfig.findOne().sort({ createdAt: -1 }).lean();
    if (cfg && cfg.isEnabled) return toMinor(cfg.fee || 0);
    return 0;
  }

  throw makeErr(400, "INVALID_SHIPPING_MODE", "Invalid shipping mode");
}

async function resolveCampaignDiscountMinor({ lineItems, subtotalMinor }) {
  const now = new Date();

  const campaigns = await Campaign.find({ isActive: true }).sort({ createdAt: -1 }).limit(5).lean();
  const activeCampaign = campaigns.find((c) => isActiveByDates(c, now)) || null;

  if (!activeCampaign) return { amountMinor: 0, campaignId: null };

  let eligibleMinor = 0;

  for (const li of lineItems) {
    const lineMinor = toMinor(li.unitPrice) * Number(li.qty || 0);

    if (activeCampaign.appliesTo === "all" || !activeCampaign.appliesTo) {
      eligibleMinor += lineMinor;
      continue;
    }

    if (activeCampaign.appliesTo === "products") {
      const hit = activeCampaign.productIds?.some((id) => id.toString() === li.productId);
      if (hit) eligibleMinor += lineMinor;
      continue;
    }

    if (activeCampaign.appliesTo === "categories") {
      const hit = activeCampaign.categoryIds?.some((id) => id.toString() === li.categoryId);
      if (hit) eligibleMinor += lineMinor;
      continue;
    }
  }

  eligibleMinor = Math.max(0, eligibleMinor);
  if (eligibleMinor <= 0) return { amountMinor: 0, campaignId: activeCampaign._id };

  let amountMinor = 0;

  if (activeCampaign.type === "percent") {
    amountMinor = computePercentDiscountMinor(eligibleMinor, activeCampaign.value);
  } else {
    amountMinor = Math.min(eligibleMinor, toMinor(activeCampaign.value || 0));
  }

  amountMinor = Math.min(amountMinor, Number(subtotalMinor || 0));
  return { amountMinor, campaignId: activeCampaign._id };
}

async function resolveCouponDiscountMinor({ code, baseMinor }) {
  const raw = String(code || "").trim();
  if (!raw) return { code: null, amountMinor: 0 };

  const now = new Date();
  const normalized = raw.toUpperCase();

  const coupon = await Coupon.findOne({ code: normalized }).lean();
  if (!coupon) return { code: null, amountMinor: 0 };
  if (!isActiveByDates(coupon, now)) return { code: null, amountMinor: 0 };

  const minMinor = toMinor(coupon.minOrderTotal || 0);
  const meetsMin = Number(baseMinor || 0) >= minMinor;

  const meetsUsage =
    coupon.usageLimit == null || Number(coupon.usedCount || 0) < Number(coupon.usageLimit || 0);

  if (!meetsMin || !meetsUsage) return { code: null, amountMinor: 0 };

  let amountMinor = 0;

  if (coupon.type === "percent") {
    amountMinor = computePercentDiscountMinor(baseMinor, coupon.value);
  } else {
    amountMinor = Math.min(Number(baseMinor || 0), toMinor(coupon.value || 0));
  }

  if (coupon.maxDiscount != null) {
    amountMinor = Math.min(amountMinor, toMinor(coupon.maxDiscount));
  }

  amountMinor = Math.min(amountMinor, Number(baseMinor || 0));
  return { code: coupon.code, amountMinor };
}

async function resolveGifts({ totalBeforeShippingMajor, lineItems }) {
  const now = new Date();

  const giftsDocs = await Gift.find({ isActive: true }).sort({ createdAt: -1 }).limit(20).lean();
  const activeGifts = giftsDocs.filter((g) => isActiveByDates(g, now));

  const cartProductIds = new Set(lineItems.map((x) => x.productId));
  const cartCategoryIds = new Set(lineItems.map((x) => x.categoryId).filter(Boolean));

  const matchedGiftIds = [];

  for (const g of activeGifts) {
    const byTotal = g.minOrderTotal != null ? totalBeforeShippingMajor >= Number(g.minOrderTotal) : true;
    const byProduct = g.requiredProductId ? cartProductIds.has(g.requiredProductId.toString()) : true;
    const byCategory = g.requiredCategoryId ? cartCategoryIds.has(g.requiredCategoryId.toString()) : true;

    if (byTotal && byProduct && byCategory && g.giftProductId) {
      matchedGiftIds.push(g.giftProductId.toString());
    }
  }

  if (!matchedGiftIds.length) return [];

  const giftProducts = await Product.find({ _id: { $in: matchedGiftIds }, isActive: true })
    .select("_id titleHe titleAr title")
    .lean();

  return giftProducts.map((gp) => ({
    productId: gp._id.toString(),
    titleHe: gp.titleHe || gp.title || "",
    titleAr: gp.titleAr || "",
    qty: 1,
  }));
}

function mergeGifts(gifts) {
  const map = new Map();

  for (const g of gifts || []) {
    const pid = String(g?.productId || "").trim();
    if (!pid) continue;

    const prev = map.get(pid);
    const qty = clampInt(g?.qty ?? 1, 1, 99);

    map.set(pid, {
      productId: pid,
      qty: prev ? clampInt(prev.qty + qty, 1, 99) : qty,
      titleHe: String(g?.titleHe || prev?.titleHe || ""),
      titleAr: String(g?.titleAr || prev?.titleAr || ""),
    });
  }

  return [...map.values()];
}

/**
 * ✅ SINGLE SOURCE OF TRUTH FOR PRICING
 * Required Output:
 * {
 *   subtotal,
 *   shippingFee,
 *   discounts: {
 *     coupon: { code?, amount },
 *     campaign: { amount },
 *     offer: { amount }
 *   },
 *   gifts: [...],
 *   total
 * }
 *
 * Additive: items[] returned for order creation + UI
 */
export async function quotePricing({ cartItems, shipping, couponCode }) {
  const now = new Date();
  const vatEnabled = String(process.env.ENABLE_VAT ?? "true").trim().toLowerCase() !== "false";
  const vatRate = vatEnabled ? 0.18 : 0;

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw makeErr(400, "EMPTY_CART", "cartItems is required");
  }

  // 1) Load products (active only)
  const ids = [
    ...new Set(
      cartItems
        .map((x) => String(x?.productId || "").trim())
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    throw makeErr(400, "INVALID_CART_ITEMS", "No valid productId in cartItems");
  }

  const products = await Product.find({ _id: { $in: ids }, isActive: true }).lean();
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const items = [];
  let subtotalMinor = 0;

  for (const c of cartItems) {
    const pid = String(c?.productId || "").trim();
    if (!pid) continue;

    const p = byId.get(pid);
    if (!p) continue;

    const stock = clampInt(p.stock ?? 0, 0, 999999);
    if (stock <= 0) continue;

    const requestedQty = clampInt(c?.qty ?? 1, 1, 999);
    const allowedQty = Math.min(requestedQty, stock);

    const unitPriceMajor = computeEffectiveUnitPriceMajor(p, now);
    const unitMinor = toMinor(unitPriceMajor);
    const lineMinor = unitMinor * allowedQty;

    items.push({
      productId: p._id.toString(),
      qty: allowedQty,
      unitPrice: fromMinor(unitMinor),
      lineTotal: fromMinor(lineMinor),
      categoryId: p.categoryId?.toString() || null,

      titleHe: p.titleHe || p.title || "",
      titleAr: p.titleAr || "",
    });

    subtotalMinor += lineMinor;
  }

  if (!items.length) {
    throw makeErr(400, "NO_AVAILABLE_ITEMS", "No available items in cart");
  }

  subtotalMinor = Math.max(0, subtotalMinor);

  // 2) Shipping base fee
  const shippingFeeBaseMinor = await resolveShippingFeeMinor(shipping);
  let shippingFeeMinor = shippingFeeBaseMinor;

  // 3) Campaign
  const campaign = await resolveCampaignDiscountMinor({ lineItems: items, subtotalMinor });
  const campaignMinor = Math.max(0, campaign.amountMinor || 0);
  const afterCampaignMinor = Math.max(0, subtotalMinor - campaignMinor);

  // 4) Coupon
  const coupon = await resolveCouponDiscountMinor({ code: couponCode, baseMinor: afterCampaignMinor });
  const couponMinor = Math.max(0, coupon.amountMinor || 0);
  const afterCouponMinor = Math.max(0, afterCampaignMinor - couponMinor);

  // 5) Offers
  const offersRes =
    (await evaluateOffers({
      lineItems: items,
      subtotalAfterCoupon: fromMinor(afterCouponMinor),
      shippingFee: fromMinor(shippingFeeMinor),
      now,
    })) || {};

  const offersDiscountMajorRaw = Number(offersRes.offersDiscount || 0);
  const offerAmountMinorRaw = toMinor(Number.isFinite(offersDiscountMajorRaw) ? offersDiscountMajorRaw : 0);

  // ✅ IMPORTANT: offer discount must not exceed current subtotal-after-coupon
  const offerAmountMinor = Math.min(afterCouponMinor, Math.max(0, offerAmountMinorRaw));

  const freeShipping = Boolean(offersRes.freeShipping);
  if (freeShipping) shippingFeeMinor = 0;

  // 6) Gifts
  const totalBeforeShippingMinor = Math.max(0, afterCouponMinor - offerAmountMinor);
  const totalBeforeShippingMajor = fromMinor(totalBeforeShippingMinor);

  const giftsFromRules = await resolveGifts({
    totalBeforeShippingMajor,
    lineItems: items,
  });

  const offerGifts = Array.isArray(offersRes.offerGifts) ? offersRes.offerGifts : [];

  const gifts = mergeGifts([
    ...giftsFromRules.map((g) => ({
      productId: String(g.productId || ""),
      qty: g.qty || 1,
      titleHe: g.titleHe || "",
      titleAr: g.titleAr || "",
    })),
    ...offerGifts.map((g) => ({
      productId: String(g.productId || ""),
      qty: g.qty || 1,
      titleHe: g.titleHe || g.title || "",
      titleAr: g.titleAr || "",
    })),
  ]);

  // 7) Total
  const totalMinor = Math.max(0, totalBeforeShippingMinor + shippingFeeMinor);

  // 8) VAT breakdown (total is VAT-inclusive)
  const totalAfterVatMinor = totalMinor;
  let totalBeforeVatMinor = totalAfterVatMinor;
  let vatAmountMinor = 0;

  if (vatRate > 0) {
    totalBeforeVatMinor = Math.max(0, Math.round(totalAfterVatMinor / (1 + vatRate)));
    vatAmountMinor = Math.max(0, totalAfterVatMinor - totalBeforeVatMinor);
  }

  return {
    subtotal: fromMinor(subtotalMinor),
    shippingFee: fromMinor(shippingFeeMinor),
    discounts: {
      coupon: { code: coupon.code || null, amount: fromMinor(couponMinor) },
      campaign: { amount: fromMinor(campaignMinor) },
      offer: { amount: fromMinor(offerAmountMinor) },
    },
    gifts,
    total: fromMinor(totalMinor),

    vatRate,
    vatAmount: fromMinor(vatAmountMinor),
    totalBeforeVat: fromMinor(totalBeforeVatMinor),
    totalAfterVat: fromMinor(totalAfterVatMinor),

    // ✅ Additive (safe)
    items,
    meta: {
      shippingFeeBase: fromMinor(shippingFeeBaseMinor),
      freeShipping,
      campaignId: campaign.campaignId || null,
    },
  };
}
