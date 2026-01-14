// src/controllers/reviews.controller.js
import {
  createReviewSchema,
  updateReviewSchema,
  listProductReviewsQuerySchema,
} from "../validators/review.validators.js";
import { getLang } from "../utils/lang.js";
import { listFeaturedReviewsPublic } from "../services/homeCatalog.service.js";
import {
  listProductReviews,
  getProductReviewsSummary,
  createReview,
  updateReview,
  deleteReview,
} from "../services/review.service.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

function pickAuth(req) {
  const a = req.auth || {};
  return {
    userId: a.userId || a.id || a._id,
    roles: a.roles || [],
  };
}

function normalizeId(id) {
  return id ? String(id) : null;
}

function toPublicReviewDTO(doc) {
  if (!doc) return doc;
  return {
    id: normalizeId(doc._id || doc.id),
    rating: doc.rating,
    title: doc.title || "",
    body: doc.body || "",
    lang: doc.lang,
    verifiedPurchase: !!doc.verifiedPurchase,
    createdAt: doc.createdAt,
  };
}

function toOwnerReviewDTO(doc) {
  if (!doc) return doc;
  return {
    id: normalizeId(doc._id || doc.id),
    productId: normalizeId(doc.productId),
    rating: doc.rating,
    title: doc.title || "",
    body: doc.body || "",
    lang: doc.lang,
    status: doc.status,
    verifiedPurchase: !!doc.verifiedPurchase,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}



export async function listFeatured(req, res) {
  const lang = getLang(req);
  const limit = req.query.limit ? Number(req.query.limit) : 3;

  const items = await listFeaturedReviewsPublic({ lang, limit });

  const userName = lang === "he" ? "לקוח מאומת" : "عميل موثوق";

  return res.status(200).json({
    ok: true,
    lang,
    items: items.map((r) => ({
      ...r,
      userName,
    })),
  });
}

export async function listForProduct(req, res) {
  const productId = req.params.productId;

  // ✅ لا تمرر req.query كامل — تجاهل lang وأي مفاتيح غير متوقعة
  const q = listProductReviewsQuerySchema.parse({
    page: req.query.page,
    limit: req.query.limit,
    sort: req.query.sort,
  });

  const out = await listProductReviews({ productId, q });
  return res.status(200).json({ ok: true, data: out.items.map(toPublicReviewDTO), meta: out.meta });
}


export async function summaryForProduct(req, res) {
  const productId = req.params.productId;
  const out = await getProductReviewsSummary({ productId, lang: req.lang });
  return res.status(200).json({ ok: true, data: out });
}

export async function createForProduct(req, res) {
  const auth = pickAuth(req);
  const productId = req.params.productId;
  const body = req.validated?.body || createReviewSchema.parse(req.body || {});

  try {
    const doc = await createReview({ productId, auth, body });

    await logAuditSuccess(req, AuditActions.REVIEW_CREATE, {
      type: "Review",
      id: normalizeId(doc._id || doc.id),
    }, { message: `Created review for product ${productId}` });

    return res.status(201).json({
      ok: true,
      data: toOwnerReviewDTO(doc),
    });
  } catch (err) {
    await logAuditFail(req, AuditActions.REVIEW_CREATE, { type: "Review" }, err);
    throw err;
  }
}


export async function updateMine(req, res) {
  const auth = pickAuth(req);
  const reviewId = req.params.id;
  const patch = req.validated?.body || updateReviewSchema.parse(req.body || {});

  try {
    const doc = await updateReview({ reviewId, auth, patch });

    await logAuditSuccess(req, AuditActions.REVIEW_UPDATE, {
      type: "Review",
      id: reviewId,
    }, { message: "Updated review" });

    return res.status(200).json({ ok: true, data: toOwnerReviewDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.REVIEW_UPDATE, { type: "Review", id: reviewId }, err);
    throw err;
  }
}

export async function deleteMine(req, res) {
  const auth = pickAuth(req);
  const reviewId = req.params.id;

  try {
    const doc = await deleteReview({ reviewId, auth });

    await logAuditSuccess(req, AuditActions.REVIEW_DELETE, {
      type: "Review",
      id: reviewId,
    }, { message: "Deleted review" });

    return res.status(200).json({ ok: true, data: toOwnerReviewDTO(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.REVIEW_DELETE, { type: "Review", id: reviewId }, err);
    throw err;
  }
}
