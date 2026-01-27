// src/services/offers.service.js

import { Offer } from "../models/Offer.js";
import { Product } from "../models/Product.js";

/**
 * ============================
 * Minor-unit money helpers (ILS agorot)
 * ============================
 */
function toMinor(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function fromMinor(minor) {
  const n = Number(minor || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function clampNum(n, min, max) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function isActiveByDates(doc, now = new Date()) {
  if (!doc?.isActive) return false;
  if (doc.startAt && now < doc.startAt) return false;
  if (doc.endAt && now > doc.endAt) return false;
  return true;
}

/**
 * Eligible amount for offer targeting:
 * - If no targeting => whole cart
 * - If productIds and/or categoryIds exist => only matching items
 *
 * lineItems shape comes from quotePricing() items:
 * { productId, qty, unitPrice, categoryId, titleHe, titleAr }
 */
function eligibleAmountMinorForOffer(offer, lineItems) {
  const hasProducts = Array.isArray(offer.productIds) && offer.productIds.length > 0;
  const hasCategories = Array.isArray(offer.categoryIds) && offer.categoryIds.length > 0;

  const productSet = hasProducts ? new Set(offer.productIds.map((id) => id.toString())) : null;
  const categorySet = hasCategories ? new Set(offer.categoryIds.map((id) => id.toString())) : null;

  let sum = 0;

  for (const li of lineItems || []) {
    const lineMinor = toMinor(li.unitPrice) * clampInt(li.qty, 1, 999);

    // No targeting => all
    if (!productSet && !categorySet) {
      sum += lineMinor;
      continue;
    }

    const pid = String(li.productId || "");
    const cid = li.categoryId ? String(li.categoryId) : "";

    const matchProduct = productSet ? productSet.has(pid) : false;
    const matchCategory = categorySet ? categorySet.has(cid) : false;

    const match =
      (productSet && matchProduct) ||
      (categorySet && matchCategory);

    if (match) sum += lineMinor;
  }

  return Math.max(0, sum);
}

function cartQtyForProduct(lineItems, productId) {
  const id = String(productId || "");
  let qty = 0;
  for (const li of lineItems || []) {
    if (String(li.productId) === id) qty += clampInt(li.qty, 1, 999);
  }
  return qty;
}

function computePercentDiscountMinor(amountMinor, percent) {
  const pct = clampNum(percent, 0, 100);
  return Math.max(0, Math.round(amountMinor * (pct / 100)));
}

/**
 * ✅ evaluateOffers
 * Inputs:
 * - lineItems: quotePricing items
 * - subtotalAfterCoupon: major
 * - shippingFee: major
 *
 * Output MUST remain compatible with pricing.service.js:
 * {
 *   appliedOffers: [...],
 *   offersDiscount: number (major),
 *   freeShipping: boolean,
 *   offerGifts: [{productId,titleHe,titleAr,qty}]
 * }
 */
export async function evaluateOffers({
  lineItems,
  subtotalAfterCoupon,
  shippingFee,
  now = new Date(),
}) {
  const subtotalAfterCouponMinor = toMinor(subtotalAfterCoupon);
  const shippingMinor = toMinor(shippingFee);

  // Hard guard
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return {
      appliedOffers: [],
      offersDiscount: 0,
      freeShipping: false,
      offerGifts: [],
    };
  }

  // Fetch offers (lean + small select)
  const offers = await Offer.find({ isActive: true })
    .sort({ priority: 1, createdAt: -1 })
    .select(
      "_id type isActive nameHe nameAr value minTotal startAt endAt maxDiscount stackable productIds categoryIds buyProductId getProductId buyQty getQty priority createdAt"
    )
    .lean();

  const active = offers.filter((o) => isActiveByDates(o, now));

  const appliedOffers = [];
  const offerGiftRequests = []; // [{productId, qty}]
  let offersDiscountMinor = 0;
  let freeShipping = false;

  for (const offer of active) {
    // Min total gate (use subtotalAfterCoupon)
    const minTotalMinor = toMinor(offer.minTotal || 0);
    if (minTotalMinor > 0 && subtotalAfterCouponMinor < minTotalMinor) continue;

    const eligibleMinor = eligibleAmountMinorForOffer(offer, lineItems);
    if (eligibleMinor <= 0) continue;

    const remainingMinor = Math.max(0, subtotalAfterCouponMinor - offersDiscountMinor);

    // If nothing left to discount, only allow FREE_SHIPPING / gifts
    const canDiscount = remainingMinor > 0;

    if (offer.type === "FREE_SHIPPING") {
      if (shippingMinor > 0) {
        freeShipping = true;
        appliedOffers.push({
          offerId: offer._id.toString(),
          type: offer.type,
          nameHe: offer.nameHe || "",
          nameAr: offer.nameAr || "",
          discount: 0,
        });
      }
      if (!offer.stackable) break;
      continue;
    }

    if (offer.type === "PERCENT_OFF") {
      if (!canDiscount) {
        if (!offer.stackable) break;
        continue;
      }

      const pct = clampNum(offer.value, 0, 100);
      if (pct <= 0) {
        if (!offer.stackable) break;
        continue;
      }

      let dMinor = computePercentDiscountMinor(eligibleMinor, pct);

      const maxDiscMinor = offer.maxDiscount != null ? toMinor(offer.maxDiscount) : 0;
      if (maxDiscMinor > 0) dMinor = Math.min(dMinor, maxDiscMinor);

      // Cap by remaining amount in cart (after coupon and already-applied offers)
      dMinor = Math.min(dMinor, remainingMinor);

      if (dMinor > 0) {
        offersDiscountMinor += dMinor;

        appliedOffers.push({
          offerId: offer._id.toString(),
          type: offer.type,
          nameHe: offer.nameHe || "",
          nameAr: offer.nameAr || "",
          value: pct,
          discount: fromMinor(dMinor),
        });
      }

      if (!offer.stackable) break;
      continue;
    }

    if (offer.type === "FIXED_OFF") {
      if (!canDiscount) {
        if (!offer.stackable) break;
        continue;
      }

      let dMinor = toMinor(clampNum(offer.value, 0, 1_000_000));

      const maxDiscMinor = offer.maxDiscount != null ? toMinor(offer.maxDiscount) : 0;
      if (maxDiscMinor > 0) dMinor = Math.min(dMinor, maxDiscMinor);

      dMinor = Math.min(dMinor, remainingMinor);

      if (dMinor > 0) {
        offersDiscountMinor += dMinor;

        appliedOffers.push({
          offerId: offer._id.toString(),
          type: offer.type,
          nameHe: offer.nameHe || "",
          nameAr: offer.nameAr || "",
          value: fromMinor(dMinor),
          discount: fromMinor(dMinor),
        });
      }

      if (!offer.stackable) break;
      continue;
    }

    if (offer.type === "BUY_X_GET_Y") {
      // Gift-only offer (no monetary discount here)
      if (!offer.buyProductId || !offer.getProductId) {
        if (!offer.stackable) break;
        continue;
      }

      const buyQty = clampInt(offer.buyQty || 1, 1, 999);
      const getQty = clampInt(offer.getQty || 1, 1, 50);

      const inCartQty = cartQtyForProduct(lineItems, offer.buyProductId);
      if (inCartQty < buyQty) {
        if (!offer.stackable) break;
        continue;
      }

      // ✅ support multiples: e.g., buy 2 get 1, cart has 4 => get 2
      const multiplier = Math.max(1, Math.floor(inCartQty / buyQty));
      const totalGiftQty = clampInt(multiplier * getQty, 1, 50);

      offerGiftRequests.push({
        productId: offer.getProductId.toString(),
        qty: totalGiftQty,
      });

      appliedOffers.push({
        offerId: offer._id.toString(),
        type: offer.type,
        nameHe: offer.nameHe || "",
        nameAr: offer.nameAr || "",
        discount: 0,
      });

      if (!offer.stackable) break;
      continue;
    }

    // Unknown type => ignore safely
  }

  // ✅ Final cap safety (never exceed subtotalAfterCoupon)
  offersDiscountMinor = Math.min(offersDiscountMinor, subtotalAfterCouponMinor);

  // Hydrate gift products snapshot
  const offerGifts = [];

  if (offerGiftRequests.length) {
    const ids = [...new Set(offerGiftRequests.map((x) => x.productId))];

    const products = await Product.find({ _id: { $in: ids }, isActive: true })
      .select("_id titleHe titleAr title")
      .lean();

    const map = new Map(products.map((p) => [p._id.toString(), p]));

    // Merge gifts by productId
    const merged = new Map();
    for (const g of offerGiftRequests) {
      const pid = String(g.productId || "");
      if (!pid) continue;

      const prev = merged.get(pid);
      const qty = clampInt(g.qty || 1, 1, 50);
      merged.set(pid, prev ? clampInt(prev + qty, 1, 50) : qty);
    }

    for (const [pid, qty] of merged.entries()) {
      const p = map.get(pid);
      if (!p) continue;

      offerGifts.push({
        productId: p._id.toString(),
        titleHe: p.titleHe || p.title || "",
        titleAr: p.titleAr || "",
        qty,
      });
    }
  }

  return {
    appliedOffers,
    offersDiscount: fromMinor(offersDiscountMinor),
    freeShipping,
    offerGifts,
  };
}
