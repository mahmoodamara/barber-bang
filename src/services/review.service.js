// src/services/review.service.js
import mongoose from "mongoose";
import { Review, Order, Product } from "../models/index.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

const PAIDISH = ["stock_confirmed", "paid", "fulfilled", "partially_refunded", "refunded"];

function isAdminOrStaff(roles = []) {
  return roles.includes("admin") || roles.includes("staff");
}

// ✅ User routes must be owner-only (no staff/admin bypass)
function ensureOwnerOnly(docUserId, auth) {
  if (docUserId && auth?.userId && String(docUserId) === String(auth.userId)) return;
  throw httpError(403, "FORBIDDEN", "Not allowed");
}

async function recalcProductReviewStats(productId) {
  const [row] = await applyQueryBudget(
    Review.aggregate([
      {
        $match: {
          productId: new mongoose.Types.ObjectId(productId),
          status: "approved",
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: "$productId",
          reviewsCount: { $sum: 1 },
          ratingAvg: { $avg: "$rating" },
        },
      },
    ]),
  );

  const reviewsCount = row?.reviewsCount || 0;
  const ratingAvg = row?.ratingAvg ?? null;

  await Product.updateOne(
    { _id: new mongoose.Types.ObjectId(productId) },
    { $set: { reviewsCount, ratingAvg } },
  );
}

async function assertProductActive(productId) {
  const p = await applyQueryBudget(
    Product.findOne({ _id: productId, isDeleted: { $ne: true } }).select("isActive").lean(),
  );
  if (!p) throw httpError(404, "PRODUCT_NOT_FOUND", "Product not found");
  if (!p.isActive) throw httpError(409, "PRODUCT_INACTIVE", "Product is not active");
}

async function requireVerifiedPurchase({ userId, productId }) {
  const paidOrder = await applyQueryBudget(
    Order.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      status: { $in: PAIDISH },
      "items.productId": new mongoose.Types.ObjectId(productId),
    })
      .select("_id status")
      .lean(),
  );

  if (!paidOrder) {
    throw httpError(
      409,
      "REVIEW_REQUIRES_PURCHASE",
      "You can review only after purchasing this product",
    );
  }

  return paidOrder._id;
}

export async function listProductReviews({ productId, q }) {
  const page = q.page;
  const limit = q.limit;

  const filter = {
    productId: new mongoose.Types.ObjectId(productId),
    status: "approved",
    isDeleted: false,
  };

  if (q.lang) filter.lang = q.lang;
  if (q.verifiedOnly) filter.verifiedPurchase = true;
  if (q.rating) filter.rating = q.rating;

  const sort =
    q.sort === "recent"
      ? { createdAt: -1 }
      : q.sort === "rating_desc"
      ? { rating: -1, createdAt: -1 }
      : { rating: 1, createdAt: -1 };

  const [items, total] = await Promise.all([
    applyQueryBudget(
      Review.find(filter)
        .select("rating title body lang verifiedPurchase createdAt")
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ),
    applyQueryBudget(Review.countDocuments(filter)),
  ]);

  return {
    items,
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function getProductReviewsSummary({ productId, lang }) {
  const match = {
    productId: new mongoose.Types.ObjectId(productId),
    status: "approved",
    isDeleted: false,
  };
  if (lang) match.lang = lang;

  const [row] = await applyQueryBudget(
    Review.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$productId",
          total: { $sum: 1 },
          avgRating: { $avg: "$rating" },
          c1: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
          c2: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
          c3: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
          c4: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
          c5: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        },
      },
    ]),
  );

  return (
    row || {
      total: 0,
      avgRating: 0,
      c1: 0,
      c2: 0,
      c3: 0,
      c4: 0,
      c5: 0,
    }
  );
}

export async function createReview({ productId, auth, body }) {
  await assertProductActive(productId);

  const userId = auth.userId;
  const verifiedOrderId = await requireVerifiedPurchase({ userId, productId });

  // prevent duplicates (unique index) مع رسالة واضحة قبل ما نعتمد على 11000
  const exists = await applyQueryBudget(
    Review.findOne({
      productId: new mongoose.Types.ObjectId(productId),
      userId: new mongoose.Types.ObjectId(userId),
      isDeleted: false,
    })
      .select("_id status")
      .lean(),
  );

  if (exists) throw httpError(409, "REVIEW_ALREADY_EXISTS", "You already reviewed this product");

  try {
    const doc = await Review.create({
      productId,
      userId,
      rating: body.rating,
      title: body.title || "",
      body: body.body || "",
      lang: body.lang || "he",
      status: "pending",
      verifiedPurchase: true,
      verifiedOrderId,
      verifiedAt: new Date(),
      moderation: { moderatedAt: null, moderatedBy: null, reason: "" },
    });

    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      throw httpError(409, "REVIEW_ALREADY_EXISTS", "You already reviewed this product");
    }
    throw err;
  }
}

/**
 * USER route: update review (owner-only)
 * - No staff/admin bypass
 * - Any user edit forces re-moderation (pending)
 */
export async function updateReview({ reviewId, auth, patch }) {
  const doc = await applyQueryBudget(Review.findById(reviewId));
  if (!doc || doc.isDeleted) throw httpError(404, "REVIEW_NOT_FOUND", "Review not found");

  const prevStatus = doc.status;
  const ratingChanged = patch.rating !== undefined;

  // ✅ owner-only (remove bypass)
  ensureOwnerOnly(doc.userId, auth);

  if (patch.rating !== undefined) doc.rating = patch.rating;
  if (patch.title !== undefined) doc.title = patch.title;
  if (patch.body !== undefined) doc.body = patch.body;
  if (patch.lang !== undefined) doc.lang = patch.lang;

  // ✅ any user edit => pending again
  doc.status = "pending";
  doc.moderation.moderatedAt = null;
  doc.moderation.moderatedBy = null;
  doc.moderation.reason = "";

  await doc.save();

  const statusChanged = prevStatus !== doc.status;
  if (
    (prevStatus === "approved" && statusChanged) ||
    (doc.status === "approved" && ratingChanged) ||
    (prevStatus !== "approved" && doc.status === "approved")
  ) {
    await recalcProductReviewStats(doc.productId);
  }

  return doc.toObject();
}

/**
 * USER route: delete review (owner-only)
 * - No staff/admin bypass
 */
export async function deleteReview({ reviewId, auth }) {
  const doc = await applyQueryBudget(Review.findById(reviewId));
  if (!doc || doc.isDeleted) throw httpError(404, "REVIEW_NOT_FOUND", "Review not found");

  const wasApproved = doc.status === "approved";

  // ✅ owner-only (remove bypass)
  ensureOwnerOnly(doc.userId, auth);

  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.status = "deleted";

  await doc.save();
  if (wasApproved) await recalcProductReviewStats(doc.productId);
  return doc.toObject();
}

/**
 * ----------------------------
 * Admin moderation operations
 * ----------------------------
 * These MUST be exposed only via Admin endpoints (RBAC guarded):
 * - list (with filters)
 * - approve
 * - reject
 */
export async function adminListReviews({ auth, q }) {
  if (!isAdminOrStaff(auth.roles)) throw httpError(403, "FORBIDDEN", "Not allowed");

  const page = q.page;
  const limit = q.limit;

  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.productId) filter.productId = new mongoose.Types.ObjectId(q.productId);
  if (q.userId) filter.userId = new mongoose.Types.ObjectId(q.userId);

  const [items, total] = await Promise.all([
    applyQueryBudget(
      Review.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ),
    applyQueryBudget(Review.countDocuments(filter)),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

export async function adminApproveReview({ reviewId, auth }) {
  if (!isAdminOrStaff(auth.roles)) throw httpError(403, "FORBIDDEN", "Not allowed");

  const doc = await applyQueryBudget(Review.findById(reviewId));
  if (!doc || doc.isDeleted) throw httpError(404, "REVIEW_NOT_FOUND", "Review not found");

  doc.status = "approved";
  doc.moderation.moderatedAt = new Date();
  doc.moderation.moderatedBy = new mongoose.Types.ObjectId(auth.userId);
  doc.moderation.reason = "";

  await doc.save();
  await recalcProductReviewStats(doc.productId);
  return doc.toObject();
}

export async function adminRejectReview({ reviewId, auth, reason }) {
  if (!isAdminOrStaff(auth.roles)) throw httpError(403, "FORBIDDEN", "Not allowed");

  const doc = await applyQueryBudget(Review.findById(reviewId));
  if (!doc || doc.isDeleted) throw httpError(404, "REVIEW_NOT_FOUND", "Review not found");

  const wasApproved = doc.status === "approved";

  doc.status = "rejected";
  doc.moderation.moderatedAt = new Date();
  doc.moderation.moderatedBy = new mongoose.Types.ObjectId(auth.userId);
  doc.moderation.reason = reason;

  await doc.save();
  if (wasApproved) await recalcProductReviewStats(doc.productId);
  return doc.toObject();
}
