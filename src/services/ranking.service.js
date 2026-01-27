// src/services/ranking.service.js
import crypto from "crypto";
import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { Order } from "../models/Order.js";
import { Review } from "../models/Review.js";
import { ProductSignalDaily } from "../models/ProductSignalDaily.js";
import { ProductEngagement } from "../models/ProductEngagement.js";

const SALES_STATUSES = new Set([
  "paid",
  "payment_received",
  "confirmed",
  "stock_confirmed",
  "shipped",
  "delivered",
]);

const ACTIVE_PRODUCT_FILTER = { isActive: true, isDeleted: { $ne: true } };

function toMinorSafe(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function startOfDayUTC(date) {
  const d = new Date(date || Date.now());
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysAgoUTC(days, now = new Date()) {
  return startOfDayUTC(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
}

function safeObjectId(id) {
  if (!id) return null;
  const v = String(id);
  return mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;
}

function normalizeActorKey({ userId, ip, userAgent }) {
  if (userId) return `u:${String(userId)}`.slice(0, 120);

  const raw = `${String(ip || "")}::${String(userAgent || "")}`.trim();
  if (!raw) return "anon";

  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `anon:${hash.slice(0, 32)}`;
}

function isReviewApproved(r) {
  if (!r) return false;
  if (r.isHidden === true) return false;
  const status = r.moderationStatus;
  if (status === undefined || status === null) return true;
  return String(status) === "approved";
}

function clampNonNeg(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, v);
}

/**
 * Best-seller score (fast, monotonic).
 * Uses 30d sales as primary, all-time as secondary.
 */
export function computeBestSellerScore({ soldCount30d = 0, soldCountAll = 0 } = {}) {
  const base = clampNonNeg(soldCount30d) * 3 + clampNonNeg(soldCountAll) * 0.2;
  return Math.log1p(base);
}

/**
 * Popularity score (weighted signals).
 * Formula:
 * views30d * 0.02 + cartAdds30d * 0.6 + wishlistCount * 0.8 + soldCount30d * 0.5
 */
export function computePopularityScore({
  views7d = 0,
  cartAdds30d = 0,
  wishlistAdds30d = 0,
  soldCount30d = 0,
} = {}) {
  const raw =
    clampNonNeg(views7d) * 0.05 +
    clampNonNeg(cartAdds30d) * 0.6 +
    clampNonNeg(wishlistAdds30d) * 0.8 +
    clampNonNeg(soldCount30d) * 0.5;
  return Math.log1p(Math.max(0, raw));
}

/**
 * Top-rated score using Bayesian average to avoid small-sample bias.
 */
export function computeTopRatedScore({ ratingAvg = 0, ratingCount = 0 } = {}) {
  const count = clampNonNeg(ratingCount);
  if (count <= 0) return 0;

  const priorMean = 4.2;
  const priorCount = 5;
  const bayesianAvg = (priorMean * priorCount + clampNonNeg(ratingAvg) * count) / (priorCount + count);
  const volumeBoost = Math.log1p(count) / 5;
  return bayesianAvg * (1 + volumeBoost);
}

function computeReviewDelta(prev, next) {
  const prevApproved = isReviewApproved(prev);
  const nextApproved = isReviewApproved(next);

  const prevRating = Number(prev?.rating || 0);
  const nextRating = Number(next?.rating || 0);

  if (prevApproved && nextApproved) {
    const delta = nextRating - prevRating;
    return {
      countDelta: 0,
      ratingDelta: delta,
      day: startOfDayUTC(next?.createdAt || prev?.createdAt || new Date()),
    };
  }

  if (prevApproved && !nextApproved) {
    return {
      countDelta: -1,
      ratingDelta: -prevRating,
      day: startOfDayUTC(prev?.createdAt || new Date()),
    };
  }

  if (!prevApproved && nextApproved) {
    return {
      countDelta: 1,
      ratingDelta: nextRating,
      day: startOfDayUTC(next?.createdAt || new Date()),
    };
  }

  return { countDelta: 0, ratingDelta: 0, day: null };
}

async function applyReviewDelta(productId, delta, now = new Date()) {
  if (!productId) return false;
  const { countDelta, ratingDelta, day } = delta || {};
  if (!countDelta && !ratingDelta) return false;

  const bucket = day || startOfDayUTC(now);

  await ProductSignalDaily.updateOne(
    { productId, day: bucket },
    {
      $inc: {
        reviewCount: Number(countDelta || 0),
        ratingSum: Number(ratingDelta || 0),
      },
      $setOnInsert: { productId, day: bucket },
    },
    { upsert: true }
  );

  await Product.updateOne(
    { _id: productId },
    { $set: { rankLastActivityAt: now } }
  );

  return true;
}

export async function recordReviewSignal({ prev, next, now = new Date() } = {}) {
  const productId =
    next?.productId?._id || next?.productId || prev?.productId?._id || prev?.productId;
  if (!productId) return false;

  const delta = computeReviewDelta(prev, next);
  return applyReviewDelta(productId, delta, now);
}

export async function recalculateProductRatingStats(productId, { now = new Date() } = {}) {
  const pid = safeObjectId(productId);
  if (!pid) return false;

  const [stats] = await Review.aggregate([
    {
      $match: {
        productId: pid,
        isHidden: { $ne: true },
        $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$productId",
        avgRating: { $avg: "$rating" },
        ratingCount: { $sum: 1 },
      },
    },
  ]);

  const avgRating = stats?.avgRating ? Number(stats.avgRating) : 0;
  const ratingCount = stats?.ratingCount ? Number(stats.ratingCount) : 0;

  await Product.updateOne(
    { _id: pid },
    {
      $set: {
        "stats.ratingAvg": avgRating,
        "stats.ratingCount": ratingCount,
      },
    }
  );

  return true;
}

export async function recordProductEngagement({
  productId,
  type,
  userId = null,
  ip = "",
  userAgent = "",
  assumeActive = false,
  now = new Date(),
} = {}) {
  const pid = safeObjectId(productId);
  if (!pid) return false;

  const eventType = String(type || "").trim();
  if (!["view", "add_to_cart", "wishlist"].includes(eventType)) return false;

  if (!assumeActive) {
    const exists = await Product.exists({ _id: pid, ...ACTIVE_PRODUCT_FILTER });
    if (!exists) return false;
  }

  const day = startOfDayUTC(now);
  const actorKey = normalizeActorKey({ userId, ip, userAgent });

  const raw = await ProductEngagement.findOneAndUpdate(
    { productId: pid, day, type: eventType, actorKey },
    { $setOnInsert: { productId: pid, day, type: eventType, actorKey, createdAt: now } },
    { upsert: true, new: false, rawResult: true }
  );

  const inserted = raw && raw.lastErrorObject && raw.lastErrorObject.updatedExisting === false;
  if (!inserted) return false;

  const inc = { views: 0, addToCart: 0, wishlisted: 0 };

  if (eventType === "view") {
    inc.views = 1;
  }
  if (eventType === "add_to_cart") {
    inc.addToCart = 1;
  }
  if (eventType === "wishlist") {
    inc.wishlisted = 1;
  }

  await ProductSignalDaily.updateOne(
    { productId: pid, day },
    {
      $inc: {
        views: inc.views,
        addToCart: inc.addToCart,
        wishlisted: inc.wishlisted,
      },
      $setOnInsert: { productId: pid, day },
    },
    { upsert: true }
  );

  const incStage = {};
  if (eventType === "view") {
    incStage["stats.views7d"] = 1;
  }
  if (eventType === "add_to_cart") {
    incStage["stats.cartAdds30d"] = 1;
  }
  if (eventType === "wishlist") {
    incStage["stats.wishlistAdds30d"] = 1;
  }

  await Product.updateOne(
    { _id: pid, ...ACTIVE_PRODUCT_FILTER },
    { $inc: incStage }
  );

  return true;
}

export async function updateWishlistCount({
  productId,
  delta = 0,
  now = new Date(),
} = {}) {
  const pid = safeObjectId(productId);
  if (!pid) return false;

  const diff = Number(delta || 0);
  if (!Number.isFinite(diff) || diff <= 0) return false;

  await Product.updateOne(
    { _id: pid, ...ACTIVE_PRODUCT_FILTER },
    { $inc: { "stats.wishlistAdds30d": diff } }
  );

  return true;
}

function aggregateOrderItems(order) {
  const map = new Map();

  for (const it of order?.items || []) {
    if (!it?.productId) continue;
    const pid = String(it.productId);
    const qty = Math.max(0, Number(it.qty || 0));
    if (qty <= 0) continue;

    const unitMinor = toMinorSafe(it.unitPrice || 0);
    const revenueMinor = unitMinor * qty;

    const existing = map.get(pid) || { units: 0, revenueMinor: 0 };
    existing.units += qty;
    existing.revenueMinor += revenueMinor;
    map.set(pid, existing);
  }

  return map;
}

function buildRefundAllocation(order, refundAmountMinor, refundItems = []) {
  const allocations = new Map();
  const items = Array.isArray(order?.items) ? order.items : [];

  if (Array.isArray(refundItems) && refundItems.length > 0) {
    for (const r of refundItems) {
      const pid = String(r?.productId || "");
      const qty = Math.max(0, Number(r?.qty || 0));
      if (!pid || qty <= 0) continue;

      const orderItem = items.find((it) => String(it?.productId || "") === pid);
      const unitMinor = toMinorSafe(orderItem?.unitPrice || 0);
      const revenueMinor = unitMinor * qty;

      const existing = allocations.get(pid) || { units: 0, revenueMinor: 0 };
      existing.units += qty;
      existing.revenueMinor += revenueMinor;
      allocations.set(pid, existing);
    }

    return allocations;
  }

  const totals = aggregateOrderItems(order);
  let orderTotalMinor = 0;
  for (const v of totals.values()) orderTotalMinor += Number(v.revenueMinor || 0);

  if (orderTotalMinor <= 0) return allocations;

  const ratio = Math.min(1, Math.max(0, Number(refundAmountMinor || 0) / orderTotalMinor));

  for (const [pid, v] of totals.entries()) {
    const units = Number(v.units || 0) * ratio;
    const revenueMinor = Number(v.revenueMinor || 0) * ratio;
    if (units <= 0 && revenueMinor <= 0) continue;

    allocations.set(pid, { units, revenueMinor });
  }

  return allocations;
}

export async function recordOrderSale(order, { now = new Date() } = {}) {
  if (!order || !order._id) return false;

  let status = String(order.status || "");
  if (!status) {
    const fresh = await Order.findById(order._id)
      .select("status items paidAt createdAt analytics")
      .lean();
    if (!fresh) return false;
    order = fresh;
    status = String(fresh.status || "");
  }

  if (!SALES_STATUSES.has(status)) return false;

  // Idempotency claim (only one worker counts sales)
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, "analytics.salesCountedAt": null },
    {
      $set: {
        "analytics.salesCountedAt": now,
        "analytics.salesCountedStatus": status,
      },
    },
    { new: true, select: "items paidAt createdAt status analytics" }
  ).lean();

  if (!claimed) return false;

  const bucket = startOfDayUTC(claimed?.paidAt || claimed?.createdAt || now);
  const items = aggregateOrderItems(claimed);
  if (items.size === 0) return false;

  const dailyOps = [];
  const productOps = [];
  const productIds = [];

  let totalUnits = 0;
  let totalRevenueMinor = 0;

  for (const [pid, v] of items.entries()) {
    const units = Number(v.units || 0);
    const revenueMinor = Number(v.revenueMinor || 0);

    totalUnits += units;
    totalRevenueMinor += revenueMinor;

    const productObjId = new mongoose.Types.ObjectId(pid);
    productIds.push(productObjId);

    dailyOps.push({
      updateOne: {
        filter: { productId: productObjId, day: bucket },
        update: {
          $inc: {
            unitsSold: units,
            revenueMinor: revenueMinor,
          },
          $setOnInsert: { productId: productObjId, day: bucket },
        },
        upsert: true,
      },
    });

    productOps.push({
      updateOne: {
        filter: { _id: productObjId },
        update: {
          $inc: {
            "stats.soldCountAll": units,
            "stats.soldCount30d": units,
          },
        },
      },
    });
  }

  if (dailyOps.length) {
    await ProductSignalDaily.bulkWrite(dailyOps, { ordered: false });
  }
  if (productOps.length) {
    await Product.bulkWrite(productOps, { ordered: false });
  }

  await Order.updateOne(
    { _id: claimed._id },
    {
      $set: {
        "analytics.salesCountedUnits": totalUnits,
        "analytics.salesCountedRevenueMinor": totalRevenueMinor,
      },
    }
  );

  return true;
}

export async function recordOrderRefund(
  order,
  { now = new Date(), refundAmountMinor = null, refundItems = [], reason = "" } = {}
) {
  if (!order || !order._id) return false;
  let analytics = order?.analytics || null;
  if (!analytics) {
    const fresh = await Order.findById(order._id).select("+analytics").lean();
    analytics = fresh?.analytics || null;
  }
  if (!analytics?.salesCountedAt) return false;

  const already = Number(analytics?.refundCountedAmountMinor || 0);
  const amountMinor =
    typeof refundAmountMinor === "number"
      ? Math.max(0, Math.round(refundAmountMinor))
      : toMinorSafe(order?.refund?.amount || order?.pricing?.total || 0);

  if (already >= amountMinor && order?.analytics?.refundCountedAt) return false;

  const allocations = buildRefundAllocation(order, amountMinor, refundItems);
  if (allocations.size === 0) return false;

  const bucket = startOfDayUTC(order?.refund?.refundedAt || now);

  const dailyOps = [];
  const productOps = [];
  const productIds = [];

  for (const [pid, v] of allocations.entries()) {
    const units = Number(v.units || 0);
    const revenueMinor = Number(v.revenueMinor || 0);

    const productObjId = new mongoose.Types.ObjectId(pid);
    productIds.push(productObjId);

    dailyOps.push({
      updateOne: {
        filter: { productId: productObjId, day: bucket },
        update: {
          $inc: {
            unitsRefunded: units,
            revenueRefundedMinor: revenueMinor,
          },
          $setOnInsert: { productId: productObjId, day: bucket },
        },
        upsert: true,
      },
    });

    productOps.push({
      updateOne: {
        filter: { _id: productObjId },
        update: {
          $inc: {
            "stats.soldCountAll": -units,
            "stats.soldCount30d": -units,
          },
        },
      },
    });
  }

  if (dailyOps.length) {
    await ProductSignalDaily.bulkWrite(dailyOps, { ordered: false });
  }
  if (productOps.length) {
    await Product.bulkWrite(productOps, { ordered: false });
  }

  if (productIds.length) {
    await Product.updateMany(
      { _id: { $in: productIds } },
      [
        {
          $set: {
            "stats.soldCountAll": { $max: [0, "$stats.soldCountAll"] },
            "stats.soldCount30d": { $max: [0, "$stats.soldCount30d"] },
          },
        },
      ]
    );
  }

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        "analytics.refundCountedAt": now,
        "analytics.refundCountedAmountMinor": amountMinor,
        "analytics.refundCountedReason": String(reason || ""),
      },
    }
  );

  return true;
}

async function backfillSignalsIfEmpty({ now = new Date(), windowDays = 90 } = {}) {
  const start = daysAgoUTC(windowDays, now);
  const existing = await ProductSignalDaily.exists({ day: { $gte: start } });
  if (existing) return { skipped: true };

  // Backfill sales from orders
  const sales = await Order.aggregate([
    {
      $match: {
        status: { $in: Array.from(SALES_STATUSES) },
        createdAt: { $gte: start },
      },
    },
    { $unwind: "$items" },
    {
      $project: {
        productId: "$items.productId",
        qty: "$items.qty",
        unitPrice: "$items.unitPrice",
        day: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: { $ifNull: ["$paidAt", "$createdAt"] },
          },
        },
      },
    },
    {
      $group: {
        _id: { productId: "$productId", day: "$day" },
        unitsSold: { $sum: "$qty" },
        revenueMajor: { $sum: { $multiply: ["$qty", "$unitPrice"] } },
      },
    },
  ]);

  if (sales.length) {
    const ops = sales.map((s) => {
      const day = startOfDayUTC(new Date(`${s._id.day}T00:00:00.000Z`));
      const revenueMinor = toMinorSafe(s.revenueMajor || 0);
      return {
        updateOne: {
          filter: { productId: s._id.productId, day },
          update: {
            $inc: { unitsSold: Number(s.unitsSold || 0), revenueMinor },
            $setOnInsert: { productId: s._id.productId, day },
          },
          upsert: true,
        },
      };
    });

    await ProductSignalDaily.bulkWrite(ops, { ordered: false });
  }

  // Backfill approved reviews
  const reviews = await Review.aggregate([
    {
      $match: {
        isHidden: { $ne: true },
        $or: [{ moderationStatus: "approved" }, { moderationStatus: { $exists: false } }],
        createdAt: { $gte: start },
      },
    },
    {
      $project: {
        productId: "$productId",
        rating: "$rating",
        day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      },
    },
    {
      $group: {
        _id: { productId: "$productId", day: "$day" },
        reviewCount: { $sum: 1 },
        ratingSum: { $sum: "$rating" },
      },
    },
  ]);

  if (reviews.length) {
    const ops = reviews.map((r) => {
      const day = startOfDayUTC(new Date(`${r._id.day}T00:00:00.000Z`));
      return {
        updateOne: {
          filter: { productId: r._id.productId, day },
          update: {
            $inc: { reviewCount: Number(r.reviewCount || 0), ratingSum: Number(r.ratingSum || 0) },
            $setOnInsert: { productId: r._id.productId, day },
          },
          upsert: true,
        },
      };
    });

    await ProductSignalDaily.bulkWrite(ops, { ordered: false });
  }

  return { skipped: false, salesRows: sales.length, reviewRows: reviews.length };
}

function computeScores({
  metrics,
  review,
  product,
  now = new Date(),
} = {}) {
  const unitsSold7 = Number(metrics?.unitsSold7 || 0);
  const unitsSold30 = Number(metrics?.unitsSold30 || 0);
  const unitsSold90 = Number(metrics?.unitsSold90 || 0);

  const unitsRefunded7 = Number(metrics?.unitsRefunded7 || 0);
  const unitsRefunded30 = Number(metrics?.unitsRefunded30 || 0);
  const unitsRefunded90 = Number(metrics?.unitsRefunded90 || 0);

  const netUnits7 = Math.max(0, unitsSold7 - unitsRefunded7);
  const netUnits30 = Math.max(0, unitsSold30 - unitsRefunded30);
  const netUnits90 = Math.max(0, unitsSold90 - unitsRefunded90);

  const revenueMinor90 = Math.max(0, Number(metrics?.revenueMinor90 || 0));
  const revenueRefundedMinor90 = Math.max(0, Number(metrics?.revenueRefundedMinor90 || 0));
  const netRevenueMinor90 = Math.max(0, revenueMinor90 - revenueRefundedMinor90);

  const views30 = Number(metrics?.views30 || 0);
  const addToCart30 = Number(metrics?.addToCart30 || 0);
  const wishlisted30 = Number(metrics?.wishlisted30 || 0);

  const salesVelocity = netUnits7 * 3 + netUnits30 * 2 + netUnits90;
  const revenueScore = netRevenueMinor90 / 10000; // 100 ILS blocks
  const salesScore = Math.log1p(Math.max(0, salesVelocity + revenueScore));

  const engagementRaw = views30 * 0.03 + addToCart30 * 0.6 + wishlisted30 * 0.8;
  const popularityScore = Math.log1p(Math.max(0, engagementRaw + netUnits30 * 0.5));

  const reviewCount = Number(review?.reviewCount || 0);
  const avgRating = Number(review?.avgRating || 0);
  const recentReviewCount = Number(review?.recentReviewCount90 || 0);

  const priorMean = 4.2;
  const priorCount = 5;
  const bayesianAvg = reviewCount > 0
    ? (avgRating * reviewCount + priorMean * priorCount) / (reviewCount + priorCount)
    : 0;

  const reviewVolumeBoost = reviewCount > 0 ? Math.log1p(reviewCount) : 0;
  const recentBoost = reviewCount > 0 ? Math.min(1, recentReviewCount / 10) : 0;

  const ratingScore = reviewCount > 0
    ? bayesianAvg * (1 + recentBoost) * reviewVolumeBoost
    : 0;

  const lastActivityAt = metrics?.lastActivityAt || review?.lastReviewAt || product?.rankLastActivityAt || product?.createdAt || now;
  const daysSince = Math.max(0, (now - new Date(lastActivityAt)) / (24 * 60 * 60 * 1000));
  const decay = Math.exp(-daysSince / 45);
  const freshnessBoost = daysSince <= 7 ? 1.15 : daysSince <= 30 ? 1.05 : 1;

  const hasVariants = Array.isArray(product?.variants) && product.variants.length > 0;
  const hasStock = hasVariants
    ? product.variants.some((v) => Number(v?.stock || 0) > 0)
    : Number(product?.stock || 0) > 0;

  const outOfStock = product?.trackInventory === true && !product?.allowBackorder && !hasStock;
  const stockPenalty = outOfStock ? 0.6 : 1;

  const baseScore = salesScore * 0.5 + popularityScore * 0.3 + ratingScore * 0.2;
  const finalRankScore = Math.max(0, baseScore * decay * freshnessBoost * stockPenalty);

  return {
    salesScore,
    popularityScore,
    ratingScore,
    finalRankScore,
    rankLastActivityAt: lastActivityAt ? new Date(lastActivityAt) : null,
  };
}

export async function recalculateProductRanking({ now = new Date(), batchSize = 500 } = {}) {
  await backfillSignalsIfEmpty({ now }).catch((e) => {
    console.warn("[ranking] backfill skipped:", String(e?.message || e));
  });

  const start7 = daysAgoUTC(7, now);
  const start30 = daysAgoUTC(30, now);

  const signalAgg = await ProductSignalDaily.aggregate([
    { $match: { day: { $gte: start30 } } },
    {
      $group: {
        _id: "$productId",
        views7d: { $sum: { $cond: [{ $gte: ["$day", start7] }, "$views", 0] } },
        cartAdds30d: { $sum: "$addToCart" },
        wishlistAdds30d: { $sum: "$wishlisted" },
        unitsSold30d: { $sum: "$unitsSold" },
        unitsRefunded30d: { $sum: "$unitsRefunded" },
      },
    },
    {
      $addFields: {
        soldCount30d: { $max: [0, { $subtract: ["$unitsSold30d", "$unitsRefunded30d"] }] },
      },
    },
  ]);

  const signalMap = new Map(signalAgg.map((s) => [String(s._id), s]));

  const reviewAgg = await Review.aggregate([
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

  const reviewMap = new Map(reviewAgg.map((r) => [String(r._id), r]));

  const cursor = Product.find(ACTIVE_PRODUCT_FILTER)
    .select("_id stock variants trackInventory allowBackorder createdAt rankLastActivityAt stats")
    .lean()
    .cursor();

  let updated = 0;
  let batch = [];

  for await (const p of cursor) {
    const id = String(p._id);
    const metrics = signalMap.get(id) || {};
    const review = reviewMap.get(id) || {};

    const views7d = Math.max(0, Number(metrics?.views7d || 0));
    const cartAdds30d = Math.max(0, Number(metrics?.cartAdds30d || 0));
    const wishlistAdds30d = Math.max(0, Number(metrics?.wishlistAdds30d || 0));
    const soldCount30d = Math.max(0, Number(metrics?.soldCount30d || 0));
    const ratingAvg = Number(review?.avgRating || 0);
    const ratingCount = Number(review?.reviewCount || 0);

    batch.push({
      updateOne: {
        filter: { _id: p._id },
        update: {
          $set: {
            "stats.soldCount30d": soldCount30d,
            "stats.views7d": views7d,
            "stats.cartAdds30d": cartAdds30d,
            "stats.wishlistAdds30d": wishlistAdds30d,
            "stats.ratingAvg": ratingAvg,
            "stats.ratingCount": ratingCount,
          },
        },
      },
    });

    if (batch.length >= batchSize) {
      await Product.bulkWrite(batch, { ordered: false });
      updated += batch.length;
      batch = [];
    }
  }

  if (batch.length) {
    await Product.bulkWrite(batch, { ordered: false });
    updated += batch.length;
  }

  return { updated, signals: signalAgg.length, reviews: reviewAgg.length };
}

export const rankingConfig = {
  SALES_STATUSES,
};
