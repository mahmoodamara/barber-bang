// src/services/pricing.service.js

import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { Coupon } from "../models/Coupon.js";
import { CouponReservation } from "../models/CouponReservation.js";
import { CouponRedemption } from "../models/CouponRedemption.js";
import { CouponUserUsage } from "../models/CouponUserUsage.js";
import { Campaign } from "../models/Campaign.js";
import { Gift } from "../models/Gift.js";
import { SiteSettings } from "../models/SiteSettings.js";
import { evaluateOffers } from "./offers.service.js";
import { DeliveryArea } from "../models/DeliveryArea.js";
import { PickupPoint } from "../models/PickupPoint.js";
import { StorePickupConfig } from "../models/StorePickupConfig.js";
import { withMongoTransaction } from "../utils/withMongoTransaction.js";

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

/**
 * ✅ DELIVERABLE #2: Coupon functions refactored to use CouponReservation/CouponRedemption collections
 *
 * Key changes:
 * - Uses CouponRedemption for tracking consumed coupons (unique index ensures idempotency)
 * - Uses CouponReservation for tracking reserved coupons (TTL index for auto-cleanup)
 * - Counters on Coupon document maintained atomically for fast limit checks
 * - Supports per-user usage limits via usagePerUser field
 */

/**
 * ✅ Atomic coupon consumption with idempotency per order
 * Uses CouponRedemption collection (unique couponId+orderId ensures idempotency)
 * Returns: { success: boolean, alreadyUsed?: boolean, error?: string }
 */
async function withCouponTransaction(session, fn) {
  if (session) return await fn(session);
  return await withMongoTransaction(async (tx) => fn(tx));
}

async function incrementUserUsage({ couponId, userId, limit, session }) {
  if (!userId || !limit || limit <= 0) return { ok: true, skipped: true };

  const opts = session ? { session } : {};
  const filter = {
    couponId,
    userId,
    $expr: { $lt: [{ $ifNull: ["$usedCount", 0] }, limit] },
  };

  try {
    const usage = await CouponUserUsage.findOneAndUpdate(
      filter,
      { $inc: { usedCount: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true, ...opts }
    );
    if (!usage) return { ok: false, error: "COUPON_USER_LIMIT_REACHED" };
    return { ok: true, usage };
  } catch (e) {
    if (e?.code === 11000) {
      const usage = await CouponUserUsage.findOneAndUpdate(
        filter,
        { $inc: { usedCount: 1 } },
        { new: true, ...opts }
      );
      if (!usage) return { ok: false, error: "COUPON_USER_LIMIT_REACHED" };
      return { ok: true, usage };
    }
    throw e;
  }
}

async function decrementUserUsage({ couponId, userId, session }) {
  if (!userId) return;
  const opts = session ? { session } : {};
  await CouponUserUsage.updateOne(
    { couponId, userId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
    opts
  ).catch(() => {});
}

export async function consumeCouponAtomic({ code, orderId, userId = null, discountAmount = 0, session = null }) {
  if (!code || !orderId) {
    return { success: false, error: "Missing code or orderId" };
  }

  const normalized = String(code).trim().toUpperCase();
  const orderObjId = mongoose.Types.ObjectId.isValid(orderId)
    ? new mongoose.Types.ObjectId(orderId)
    : null;
  if (!orderObjId) {
    return { success: false, error: "Invalid orderId" };
  }

  const userObjId =
    userId && mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;

  return await withCouponTransaction(session, async (tx) => {
    const opts = tx ? { session: tx } : {};

    // Find coupon first
    const coupon = await Coupon.findOne({ code: normalized }, null, opts);
    if (!coupon) return { success: false, error: "COUPON_NOT_FOUND" };
    if (!coupon.isActive) return { success: false, error: "COUPON_INACTIVE" };

    // Check if already redeemed by this order (idempotent)
    const existingRedemption = await CouponRedemption.findOne(
      { couponId: coupon._id, orderId: orderObjId },
      null,
      opts
    );
    if (existingRedemption) {
      return { success: true, alreadyUsed: true };
    }

    // Check usage limit
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      return { success: false, error: "COUPON_LIMIT_REACHED" };
    }

    // Atomic per-user usage check + increment (transactional)
    let usageUpdated = false;
    if (userObjId && coupon.usagePerUser) {
      const usageRes = await incrementUserUsage({
        couponId: coupon._id,
        userId: userObjId,
        limit: coupon.usagePerUser,
        session: tx,
      });
      if (!usageRes.ok) return { success: false, error: usageRes.error || "COUPON_USER_LIMIT_REACHED" };
      usageUpdated = true;
    }

    // Create redemption record (unique index ensures idempotency)
    try {
      await CouponRedemption.create(
        [
          {
            couponId: coupon._id,
            orderId: orderObjId,
            userId: userObjId,
            couponCode: normalized,
            discountAmount: Number(discountAmount || 0),
            redeemedAt: new Date(),
          },
        ],
        opts
      );
    } catch (e) {
      // Duplicate key error = already redeemed (concurrent request)
      if (e.code === 11000) {
        if (usageUpdated) {
          await decrementUserUsage({ couponId: coupon._id, userId: userObjId, session: tx });
        }
        return { success: true, alreadyUsed: true };
      }
      throw e;
    }

    // Increment usedCount on Coupon (best-effort, for fast limit checks)
    await Coupon.updateOne(
      { _id: coupon._id },
      { $inc: { usedCount: 1 } },
      opts
    ).catch((e) => {
      console.warn("[coupon] usedCount increment failed:", String(e?.message || e));
    });

    return { success: true, alreadyUsed: false };
  });
}

/**
 * ✅ Reserve a coupon usage for a specific order (Stripe flow)
 * Uses CouponReservation collection with TTL index for auto-cleanup
 *
 * CONCURRENCY-SAFE: Uses atomic findOneAndUpdate with $expr conditions
 * to prevent race conditions when multiple requests compete for the same coupon.
 */
export async function reserveCouponAtomic({
  code,
  orderId,
  userId = null,
  ttlMinutes = 15,
  session = null,
} = {}) {
  if (!code || !orderId) {
    return { success: false, error: "Missing code or orderId" };
  }

  const normalized = String(code).trim().toUpperCase();
  const orderObjId = mongoose.Types.ObjectId.isValid(orderId)
    ? new mongoose.Types.ObjectId(orderId)
    : null;
  if (!orderObjId) {
    return { success: false, error: "Invalid orderId" };
  }

  const userObjId = userId && mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : null;

  const now = new Date();
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMinutes) * 60 * 1000);
  const opts = session ? { session } : {};

  // Find coupon first to validate basic conditions
  const coupon = await Coupon.findOne({ code: normalized }, null, opts);
  if (!coupon) return { success: false, error: "COUPON_NOT_FOUND" };
  if (!coupon.isActive) return { success: false, error: "COUPON_INACTIVE" };
  if (!isActiveByDates(coupon, now)) return { success: false, error: "COUPON_EXPIRED" };

  // Check if already reserved by this order
  const existingReservation = await CouponReservation.findOne(
    { couponId: coupon._id, orderId: orderObjId, status: "active" },
    null,
    opts
  );
  if (existingReservation) {
    return { success: true, alreadyReserved: true, expiresAt: existingReservation.expiresAt };
  }

  // Check if already redeemed by this order
  const existingRedemption = await CouponRedemption.findOne(
    { couponId: coupon._id, orderId: orderObjId },
    null,
    opts
  );
  if (existingRedemption) {
    return { success: true, alreadyReserved: true, alreadyUsed: true, expiresAt };
  }

  // Check per-user limit using usage counter (avoid countDocuments)
  if (userObjId && coupon.usagePerUser) {
    const usage = await CouponUserUsage.findOne(
      { couponId: coupon._id, userId: userObjId },
      null,
      opts
    );
    if (usage && Number(usage.usedCount || 0) >= coupon.usagePerUser) {
      return { success: false, error: "COUPON_USER_LIMIT_REACHED" };
    }
  }

  // ✅ ATOMIC: Increment reservedCount with condition check
  const updateFilter = {
    _id: coupon._id,
    isActive: true,
  };

  if (coupon.usageLimit) {
    updateFilter.$expr = {
      $lt: [
        { $add: [{ $ifNull: ["$usedCount", 0] }, { $ifNull: ["$reservedCount", 0] }] },
        coupon.usageLimit,
      ],
    };
  }

  const updatedCoupon = await Coupon.findOneAndUpdate(
    updateFilter,
    { $inc: { reservedCount: 1 } },
    { new: true, ...opts }
  );

  if (!updatedCoupon) {
    return { success: false, error: "COUPON_LIMIT_REACHED" };
  }

  // Create reservation record (unique index on couponId+orderId ensures idempotency)
  let reservation;
  try {
    [reservation] = await CouponReservation.create(
      [
        {
          couponId: coupon._id,
          orderId: orderObjId,
          userId: userObjId,
          couponCode: normalized,
          expiresAt,
          status: "active",
        },
      ],
      opts
    );
  } catch (e) {
    if (e.code === 11000) {
      // Rollback the reservedCount increment (guard prevents negative counter)
      await Coupon.updateOne(
        { _id: coupon._id, reservedCount: { $gt: 0 } },
        { $inc: { reservedCount: -1 } },
        opts
      ).catch(() => {});

      // Check if this order already has a reservation (idempotent case)
      const existingByOrder = await CouponReservation.findOne(
        { couponId: coupon._id, orderId: orderObjId },
        null,
        opts
      );
      if (existingByOrder) {
        return { success: true, alreadyReserved: true, expiresAt: existingByOrder.expiresAt || expiresAt };
      }

      // If no reservation for this order, duplicate was from userId index
      if (userObjId) {
        return { success: false, error: "COUPON_USER_LIMIT_REACHED" };
      }

      return { success: true, alreadyReserved: true, expiresAt };
    }
    // Rollback on other errors (guard prevents negative counter)
    await Coupon.updateOne(
      { _id: coupon._id, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1 } },
      opts
    ).catch(() => {});
    throw e;
  }

  return { success: true, reserved: true, expiresAt };
}

/**
 * ✅ Release a coupon reservation
 * Marks CouponReservation as released and decrements reservedCount
 */
export async function releaseCouponReservation({ code, orderId, session = null } = {}) {
  if (!code || !orderId) return { success: false, error: "Missing code or orderId" };

  const normalized = String(code).trim().toUpperCase();
  const orderObjId = mongoose.Types.ObjectId.isValid(orderId)
    ? new mongoose.Types.ObjectId(orderId)
    : null;
  if (!orderObjId) {
    return { success: false, error: "Invalid orderId" };
  }

  const opts = session ? { session } : {};

  // Find and update reservation atomically
  const reservation = await CouponReservation.findOneAndUpdate(
    { couponCode: normalized, orderId: orderObjId, status: "active" },
    { $set: { status: "released" } },
    { new: true, ...opts }
  );

  if (!reservation) {
    return { success: false, error: "RESERVATION_NOT_FOUND" };
  }

  // Decrement reservedCount on Coupon (best-effort)
  await Coupon.updateOne(
    { _id: reservation.couponId, reservedCount: { $gt: 0 } },
    { $inc: { reservedCount: -1 } },
    opts
  ).catch((e) => {
    console.warn("[coupon] reservedCount decrement failed:", String(e?.message || e));
  });

  return { success: true };
}

/**
 * ✅ Consume a previously reserved coupon
 * Converts CouponReservation to CouponRedemption atomically.
 * Requires an active reservation; does not create a redemption or change counters if none exists.
 */
export async function consumeReservedCoupon({ code, orderId, userId = null, discountAmount = 0, session = null } = {}) {
  if (!code || !orderId) {
    return { success: false, error: "Missing code or orderId" };
  }

  const normalized = String(code).trim().toUpperCase();
  const orderObjId = mongoose.Types.ObjectId.isValid(orderId)
    ? new mongoose.Types.ObjectId(orderId)
    : null;
  if (!orderObjId) {
    return { success: false, error: "Invalid orderId" };
  }

  return await withCouponTransaction(session, async (tx) => {
    const opts = tx ? { session: tx } : {};

    // Find coupon
    const coupon = await Coupon.findOne({ code: normalized }, null, opts);
    if (!coupon) return { success: false, error: "COUPON_NOT_FOUND" };

    // Check if already redeemed (idempotent)
    const existingRedemption = await CouponRedemption.findOne(
      { couponId: coupon._id, orderId: orderObjId },
      null,
      opts
    );
    if (existingRedemption) {
      return { success: true, alreadyUsed: true };
    }

    // Find active reservation - required; fail if missing
    const reservation = await CouponReservation.findOne(
      { couponId: coupon._id, orderId: orderObjId, status: "active" },
      null,
      opts
    );
    if (!reservation) {
      return { success: false, error: "RESERVATION_NOT_FOUND" };
    }

    // Infer userId from reservation when not passed
    const finalUserId = userId ?? reservation.userId;
    const userObjId =
      finalUserId && mongoose.Types.ObjectId.isValid(finalUserId)
        ? new mongoose.Types.ObjectId(finalUserId)
        : null;

    // Atomic per-user usage check + increment (transactional)
    let usageUpdated = false;
    if (userObjId && coupon.usagePerUser) {
      const usageRes = await incrementUserUsage({
        couponId: coupon._id,
        userId: userObjId,
        limit: coupon.usagePerUser,
        session: tx,
      });
      if (!usageRes.ok) return { success: false, error: usageRes.error || "COUPON_USER_LIMIT_REACHED" };
      usageUpdated = true;
    }

    // Create redemption record (only path that creates it)
    try {
      await CouponRedemption.create(
        [
          {
            couponId: coupon._id,
            orderId: orderObjId,
            userId: userObjId,
            couponCode: normalized,
            discountAmount: Number(discountAmount || 0),
            redeemedAt: new Date(),
          },
        ],
        opts
      );
    } catch (e) {
      if (e.code === 11000) {
        if (usageUpdated) {
          await decrementUserUsage({ couponId: coupon._id, userId: userObjId, session: tx });
        }
        return { success: true, alreadyUsed: true };
      }
      throw e;
    }

    // Mark reservation as consumed
    await CouponReservation.updateOne(
      { _id: reservation._id },
      { $set: { status: "consumed" } },
      opts
    ).catch(() => {});

    // Decrement reservedCount only if > 0, increment usedCount (prevents negative reservedCount)
    await Coupon.updateOne(
      { _id: coupon._id, reservedCount: { $gt: 0 } },
      { $inc: { reservedCount: -1, usedCount: 1 } },
      opts
    ).catch((e) => {
      console.warn("[coupon] counter update failed:", String(e?.message || e));
    });

    return { success: true };
  });
}

function makeErr(statusCode, code, message, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function isActiveByDates(doc, now = new Date()) {
  if (!doc?.isActive) return false;
  if (doc.startAt && now < doc.startAt) return false;
  if (doc.endAt && now > doc.endAt) return false;
  return true;
}

function normalizeKey(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  return v
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildLegacyAttributes(variant) {
  if (!variant) return [];
  const legacy = [
    { key: "volume_ml", type: "number", value: variant.volumeMl, unit: "ml" },
    { key: "weight_g", type: "number", value: variant.weightG, unit: "g" },
    { key: "pack_count", type: "number", value: variant.packCount, unit: "" },
    { key: "scent", type: "text", value: variant.scent },
    { key: "hold_level", type: "text", value: variant.holdLevel },
    { key: "finish_type", type: "text", value: variant.finishType },
    { key: "skin_type", type: "text", value: variant.skinType },
  ];

  return legacy
    .map((a) => {
      if (a.type === "number") {
        const n = Number(a.value);
        if (!Number.isFinite(n)) return null;
        return { ...a, value: n };
      }
      const s = String(a.value || "").trim();
      if (!s) return null;
      return { ...a, value: s };
    })
    .filter(Boolean);
}

function normalizeAttributesList(variant) {
  const attrs = Array.isArray(variant?.attributes) ? variant.attributes : [];
  const normalized = attrs
    .map((a) => ({
      key: normalizeKey(a?.key),
      type: String(a?.type || ""),
      value: a?.value ?? null,
      valueKey: normalizeKey(a?.valueKey),
      unit: String(a?.unit || ""),
    }))
    .filter((a) => a.key && a.type);

  const keys = new Set(normalized.map((a) => a.key));
  for (const la of buildLegacyAttributes(variant)) {
    if (!keys.has(la.key)) normalized.push(la);
  }

  return normalized;
}

function legacyAttributesObject(list) {
  const obj = {
    volumeMl: null,
    weightG: null,
    packCount: null,
    scent: "",
    holdLevel: "",
    finishType: "",
    skinType: "",
  };

  for (const a of list || []) {
    const key = String(a?.key || "");
    const val = a?.value;
    if (key === "volume_ml" && Number.isFinite(Number(val))) obj.volumeMl = Number(val);
    if (key === "weight_g" && Number.isFinite(Number(val))) obj.weightG = Number(val);
    if (key === "pack_count" && Number.isFinite(Number(val))) obj.packCount = Number(val);
    if (key === "scent" && typeof val === "string") obj.scent = val;
    if (key === "hold_level" && typeof val === "string") obj.holdLevel = val;
    if (key === "finish_type" && typeof val === "string") obj.finishType = val;
    if (key === "skin_type" && typeof val === "string") obj.skinType = val;
  }

  return obj;
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

export function computeEffectiveUnitPriceMinor(p, variant, now = new Date()) {
  const productPriceMinor = Number.isFinite(Number(p?.priceMinor))
    ? Math.max(0, Math.round(Number(p.priceMinor)))
    : toMinor(p?.price);
  const productSalePriceMinor = Number.isFinite(Number(p?.salePriceMinor))
    ? Math.max(0, Math.round(Number(p.salePriceMinor)))
    : toMinor(p?.salePrice);

  // ✅ FIX: Only use variant priceOverride if it's explicitly set AND > 0
  // A value of 0 means "no override" (fall back to product price)
  const variantOverrideMinor = Number(variant?.priceOverrideMinor);
  const hasValidOverrideMinor = Number.isFinite(variantOverrideMinor) && variantOverrideMinor > 0;

  const variantOverrideMajor = Number(variant?.priceOverride);
  const hasValidOverrideMajor = Number.isFinite(variantOverrideMajor) && variantOverrideMajor > 0;

  const baseMinor = hasValidOverrideMinor
    ? variantOverrideMinor
    : hasValidOverrideMajor
      ? toMinor(variant.priceOverride)
      : productPriceMinor;

  const saleActive = productSaleActiveByPrice(p, now);
  const saleEligible =
    saleActive &&
    Number.isFinite(productSalePriceMinor) &&
    productSalePriceMinor < productPriceMinor &&
    productSalePriceMinor < baseMinor;

  return saleEligible ? productSalePriceMinor : baseMinor;
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

/**
 * ✅ Deterministic campaign selection:
 * 1. Filter by isActive + date range
 * 2. Sort by priority ASC (lower = first)
 * 3. Tie-break by higher discount potential, then createdAt DESC
 * Only one campaign applies (first in sorted order wins)
 */
async function resolveCampaignDiscountMinor({ lineItems, subtotalMinor }) {
  const now = new Date();

  // Fetch all active campaigns sorted by priority ASC, then createdAt DESC for tie-break
  const campaigns = await Campaign.find({ isActive: true })
    .sort({ priority: 1, createdAt: -1 })
    .limit(20)
    .lean();

  // Filter by active date range
  const activeCampaigns = campaigns.filter((c) => isActiveByDates(c, now));

  if (!activeCampaigns.length) return { amountMinor: 0, campaignId: null, campaignName: null };

  // Calculate potential discount for each campaign to enable deterministic tie-breaking
  const campaignsWithDiscount = activeCampaigns.map((campaign) => {
    let eligibleMinor = 0;

    for (const li of lineItems) {
      const lineMinor = toMinor(li.unitPrice) * Number(li.qty || 0);

      if (campaign.appliesTo === "all" || !campaign.appliesTo) {
        eligibleMinor += lineMinor;
        continue;
      }

      if (campaign.appliesTo === "products") {
        const hit = campaign.productIds?.some((id) => id.toString() === li.productId);
        if (hit) eligibleMinor += lineMinor;
        continue;
      }

      if (campaign.appliesTo === "categories") {
        const hit = campaign.categoryIds?.some((id) => id.toString() === li.categoryId);
        if (hit) eligibleMinor += lineMinor;
        continue;
      }
    }

    let potentialDiscount = 0;
    if (eligibleMinor > 0) {
      if (campaign.type === "percent") {
        potentialDiscount = computePercentDiscountMinor(eligibleMinor, campaign.value);
      } else {
        potentialDiscount = Math.min(eligibleMinor, toMinor(campaign.value || 0));
      }
      potentialDiscount = Math.min(potentialDiscount, subtotalMinor);
    }

    return { campaign, eligibleMinor, potentialDiscount };
  });

  // Sort by: priority ASC, then potentialDiscount DESC, then createdAt DESC (already sorted)
  campaignsWithDiscount.sort((a, b) => {
    const priorityA = a.campaign.priority ?? 100;
    const priorityB = b.campaign.priority ?? 100;
    if (priorityA !== priorityB) return priorityA - priorityB;
    // Higher discount wins
    if (b.potentialDiscount !== a.potentialDiscount) return b.potentialDiscount - a.potentialDiscount;
    // createdAt DESC (newer first) - already sorted but ensure
    return (b.campaign.createdAt?.getTime?.() || 0) - (a.campaign.createdAt?.getTime?.() || 0);
  });

  // Pick the best campaign (first one after sorting)
  const best = campaignsWithDiscount[0];
  if (!best || best.potentialDiscount <= 0) {
    return { amountMinor: 0, campaignId: null, campaignName: null };
  }

  const activeCampaign = best.campaign;
  const amountMinor = best.potentialDiscount;

  return {
    amountMinor,
    campaignId: activeCampaign._id,
    campaignName: activeCampaign.nameHe || activeCampaign.name || null,
  };
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

/**
 * ✅ Resolve gifts with stock validation
 * Returns gifts with stock info + validation warnings
 */
async function resolveGifts({ totalBeforeShippingMajor, lineItems }) {
  const now = new Date();

  const giftsDocs = await Gift.find({ isActive: true }).sort({ createdAt: -1 }).limit(20).lean();
  const activeGifts = giftsDocs.filter((g) => isActiveByDates(g, now));

  const cartProductIds = new Set(lineItems.map((x) => x.productId));
  const cartCategoryIds = new Set(lineItems.map((x) => x.categoryId).filter(Boolean));

  const matchedGiftRequests = [];

  for (const g of activeGifts) {
    const byTotal = g.minOrderTotal != null ? totalBeforeShippingMajor >= Number(g.minOrderTotal) : true;
    const byProduct = g.requiredProductId ? cartProductIds.has(g.requiredProductId.toString()) : true;
    const byCategory = g.requiredCategoryId ? cartCategoryIds.has(g.requiredCategoryId.toString()) : true;

    if (byTotal && byProduct && byCategory && g.giftProductId) {
      matchedGiftRequests.push({
        productId: g.giftProductId.toString(),
        variantId: null, // rule-based gifts don't support variants yet
        requestedQty: 1,
        giftRuleId: g._id.toString(),
        giftRuleName: g.nameHe || g.name || "",
      });
    }
  }

  if (!matchedGiftRequests.length) return { gifts: [], giftWarnings: [] };

  const giftProductIds = [...new Set(matchedGiftRequests.map((x) => x.productId))];
  const giftProducts = await Product.find({
    _id: { $in: giftProductIds },
    isActive: true,
    isDeleted: { $ne: true },
  })
    .select("_id titleHe titleAr title stock variants")
    .lean();

  const productMap = new Map(giftProducts.map((p) => [p._id.toString(), p]));

  const gifts = [];
  const giftWarnings = [];

  for (const req of matchedGiftRequests) {
    const product = productMap.get(req.productId);
    if (!product) {
      giftWarnings.push({
        type: "GIFT_PRODUCT_NOT_FOUND",
        productId: req.productId,
        message: `Gift product not found or inactive`,
      });
      continue;
    }

    // Check stock (for non-variant products)
    const availableStock = clampInt(product.stock ?? 0, 0, 999999);
    const grantedQty = Math.min(req.requestedQty, availableStock);

    if (grantedQty <= 0) {
      giftWarnings.push({
        type: "GIFT_OUT_OF_STOCK",
        productId: req.productId,
        titleHe: product.titleHe || product.title || "",
        requestedQty: req.requestedQty,
        availableStock: 0,
        message: `Gift "${product.titleHe || product.title}" is out of stock`,
      });
      continue;
    }

    if (grantedQty < req.requestedQty) {
      giftWarnings.push({
        type: "GIFT_PARTIAL_STOCK",
        productId: req.productId,
        titleHe: product.titleHe || product.title || "",
        requestedQty: req.requestedQty,
        grantedQty,
        availableStock,
        message: `Gift "${product.titleHe || product.title}" limited to ${grantedQty} (requested ${req.requestedQty})`,
      });
    }

    gifts.push({
      productId: product._id.toString(),
      variantId: req.variantId || null,
      titleHe: product.titleHe || product.title || "",
      titleAr: product.titleAr || "",
      qty: grantedQty,
      source: "rule",
    });
  }

  return { gifts, giftWarnings };
}

/**
 * ✅ Merge gifts by productId+variantId combo
 * Preserves source and metadata
 */
function mergeGifts(gifts) {
  const map = new Map();

  for (const g of gifts || []) {
    const pid = String(g?.productId || "").trim();
    if (!pid) continue;

    const vid = String(g?.variantId || "").trim();
    const key = `${pid}:${vid}`;

    const prev = map.get(key);
    const qty = clampInt(g?.qty ?? 1, 1, 99);

    map.set(key, {
      productId: pid,
      variantId: vid || null,
      qty: prev ? clampInt(prev.qty + qty, 1, 99) : qty,
      titleHe: String(g?.titleHe || prev?.titleHe || ""),
      titleAr: String(g?.titleAr || prev?.titleAr || ""),
      source: g?.source || prev?.source || "unknown",
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
  const vatRateRaw = Number(process.env.VAT_RATE ?? 0.18);
  const vatRate = vatEnabled ? Math.min(1, Math.max(0, vatRateRaw)) : 0;

  // ✅ Load VAT mode from settings (default true for IL B2C)
  const settings = await SiteSettings.findOne().lean();
  const pricesIncludeVat = Boolean(settings?.pricingRules?.pricesIncludeVat ?? true);

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw makeErr(400, "EMPTY_CART", "cartItems is required");
  }

  // 1) Load products (active and not deleted)
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

  const products = await Product.find({
    _id: { $in: ids },
    isActive: true,
    isDeleted: { $ne: true },
  }).lean();
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const items = [];
  let subtotalMinor = 0;

  for (const c of cartItems) {
    const pid = String(c?.productId || "").trim();
    if (!pid) continue;

    const p = byId.get(pid);
    if (!p) continue;

    const variantId = String(c?.variantId || "").trim();
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const variant = hasVariants
      ? p.variants.find((v) => String(v?._id || "") === variantId)
      : null;

    if (hasVariants && !variant) {
      throw makeErr(400, "VARIANT_REQUIRED", "variantId is required for this product");
    }

    const stock = hasVariants ? clampInt(variant?.stock ?? 0, 0, 999999) : clampInt(p.stock ?? 0, 0, 999999);
    const requestedQty = clampInt(c?.qty ?? 1, 1, 999);

    /**
     * ✅ DELIVERABLE #3: Prevent silent quantity reduction
     * Instead of silently reducing qty to available stock, reject with 409 error
     * This ensures frontend is aware of stock issues before checkout completion
     */
    if (stock <= 0) {
      throw makeErr(409, "OUT_OF_STOCK", "Product is out of stock", {
        items: [{
          productId: p._id.toString(),
          variantId: variant ? String(variant?._id || "") : null,
          titleHe: p.titleHe || p.title || "",
          titleAr: p.titleAr || "",
          requested: requestedQty,
          available: 0,
        }],
      });
    }

    if (requestedQty > stock) {
      throw makeErr(409, "OUT_OF_STOCK_PARTIAL", "Requested quantity exceeds available stock", {
        items: [{
          productId: p._id.toString(),
          variantId: variant ? String(variant?._id || "") : null,
          titleHe: p.titleHe || p.title || "",
          titleAr: p.titleAr || "",
          requested: requestedQty,
          available: stock,
        }],
      });
    }

    const allowedQty = requestedQty; // No silent reduction

    const unitMinor = computeEffectiveUnitPriceMinor(p, variant, now);
    const lineMinor = unitMinor * allowedQty;

    const attributesList = variant ? normalizeAttributesList(variant) : [];

    items.push({
      productId: p._id.toString(),
      variantId: variant ? String(variant?._id || "") : "",
      variantSnapshot: variant
        ? {
            variantId: String(variant?._id || ""),
            sku: String(variant?.sku || ""),
            price: fromMinor(unitMinor),
            priceMinor: Math.max(0, Math.round(unitMinor)),
            attributesList,
            attributes: {
              ...legacyAttributesObject(attributesList),
            },
          }
        : null,
      qty: allowedQty,
      unitPrice: fromMinor(unitMinor),
      unitPriceMinor: Math.max(0, Math.round(unitMinor)),
      lineTotal: fromMinor(lineMinor),
      lineTotalMinor: Math.max(0, Math.round(lineMinor)),
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

  const giftsFromRulesResult = await resolveGifts({
    totalBeforeShippingMajor,
    lineItems: items,
  });

  const giftsFromRules = giftsFromRulesResult.gifts || [];
  const giftWarningsFromRules = giftsFromRulesResult.giftWarnings || [];

  const offerGifts = Array.isArray(offersRes.offerGifts) ? offersRes.offerGifts : [];
  const offerGiftWarnings = Array.isArray(offersRes.offerGiftWarnings) ? offersRes.offerGiftWarnings : [];

  const gifts = mergeGifts([
    ...giftsFromRules.map((g) => ({
      productId: String(g.productId || ""),
      variantId: g.variantId || null,
      qty: g.qty || 1,
      titleHe: g.titleHe || "",
      titleAr: g.titleAr || "",
      source: "rule",
    })),
    ...offerGifts.map((g) => ({
      productId: String(g.productId || ""),
      variantId: g.variantId || null,
      qty: g.qty || 1,
      titleHe: g.titleHe || g.titleHe || "",
      titleAr: g.titleAr || "",
      source: "offer",
    })),
  ]);

  // Collect all gift warnings
  const giftWarnings = [...giftWarningsFromRules, ...offerGiftWarnings];

  // 7) Total (before VAT adjustment for VAT-exclusive mode)
  let totalMinor = Math.max(0, totalBeforeShippingMinor + shippingFeeMinor);

  // 8) VAT breakdown - handles both VAT-inclusive and VAT-exclusive pricing modes
  let totalAfterVatMinor = 0;
  let totalBeforeVatMinor = 0;
  let vatAmountMinor = 0;

  if (vatRate > 0) {
    if (pricesIncludeVat) {
      // ✅ VAT-INCLUSIVE: Catalog prices already include VAT (IL B2C default)
      // totalMinor is the final amount including VAT
      totalAfterVatMinor = totalMinor;
      totalBeforeVatMinor = Math.max(0, Math.round(totalAfterVatMinor / (1 + vatRate)));
      vatAmountMinor = Math.max(0, totalAfterVatMinor - totalBeforeVatMinor);
    } else {
      // ✅ VAT-EXCLUSIVE: Catalog prices are net, VAT is added on top
      // totalMinor is net amount, we need to add VAT
      totalBeforeVatMinor = totalMinor;
      vatAmountMinor = Math.max(0, Math.round(totalBeforeVatMinor * vatRate));
      totalAfterVatMinor = totalBeforeVatMinor + vatAmountMinor;
      // Update totalMinor to include VAT for Stripe
      totalMinor = totalAfterVatMinor;
    }
  } else {
    // No VAT
    totalAfterVatMinor = totalMinor;
    totalBeforeVatMinor = totalMinor;
    vatAmountMinor = 0;
  }

  // ✅ Assertion in dev/test: Verify VAT math equality holds
  if (process.env.NODE_ENV !== "production") {
    const vatEquality = totalBeforeVatMinor + vatAmountMinor === totalAfterVatMinor;
    if (!vatEquality) {
      console.error(
        `[pricing.service] VAT MATH ASSERTION FAILED: ${totalBeforeVatMinor} + ${vatAmountMinor} !== ${totalAfterVatMinor}`
      );
    }
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
    vatIncludedInPrices: pricesIncludeVat,
    vatAmount: fromMinor(vatAmountMinor),
    totalBeforeVat: fromMinor(totalBeforeVatMinor),
    totalAfterVat: fromMinor(totalAfterVatMinor),

    subtotalMinor: Math.max(0, Math.round(subtotalMinor)),
    shippingFeeMinor: Math.max(0, Math.round(shippingFeeMinor)),
    discountsMinor: {
      coupon: { amount: Math.max(0, Math.round(couponMinor)) },
      campaign: { amount: Math.max(0, Math.round(campaignMinor)) },
      offer: { amount: Math.max(0, Math.round(offerAmountMinor)) },
    },
    totalMinor: Math.max(0, Math.round(totalMinor)),
    vatAmountMinor: Math.max(0, Math.round(vatAmountMinor)),
    totalBeforeVatMinor: Math.max(0, Math.round(totalBeforeVatMinor)),
    totalAfterVatMinor: Math.max(0, Math.round(totalAfterVatMinor)),

    // ✅ Additive (safe)
    items,
    meta: {
      // Shipping transparency
      shippingFeeBase: fromMinor(shippingFeeBaseMinor),
      shippingFeeBaseMinor: Math.max(0, Math.round(shippingFeeBaseMinor)),
      shippingFeeMinor: Math.max(0, Math.round(shippingFeeMinor)),
      freeShipping,

      // Campaign transparency
      campaignId: campaign.campaignId || null,
      campaignName: campaign.campaignName || null,

      // ✅ Applied offers transparency (Goal 6)
      appliedOffers: Array.isArray(offersRes.appliedOffers) ? offersRes.appliedOffers : [],

      // Gift warnings (out of stock, partial stock, etc.)
      giftWarnings: giftWarnings.length > 0 ? giftWarnings : [],
    },
  };
}
