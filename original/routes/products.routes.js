// src/routes/products.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { Review } from "../models/Review.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

/* -------------------------------- Helpers -------------------------------- */

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonErr(res, e) {
  return res.status(e.statusCode || 500).json({
    ok: false,
    error: {
      code: e.code || "INTERNAL_ERROR",
      message: e.message || "Unexpected error",
    },
  });
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

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

function mapProductListItem(p, lang, now) {
  const onSale = isSaleActiveByPrice(p, now);

  return {
    id: p._id,
    _id: p._id,

    // ✅ Unified fields used by frontend
    title: t(p, "title", lang),
    description: t(p, "description", lang),

    // ✅ Additive bilingual (does not break anything)
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    descriptionHe: p.descriptionHe || p.description || "",
    descriptionAr: p.descriptionAr || "",

    price: Number(p.price || 0),
    stock: Number(p.stock || 0),
    categoryId: p.categoryId || null,
    imageUrl: p.imageUrl || "",
    isActive: Boolean(p.isActive),

    isFeatured: Boolean(p.isFeatured),
    isBestSeller: Boolean(p.isBestSeller),

    // ✅ Sale block only when active by rule
    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          discountPercent: p.discountPercent ?? null, // ✅ additive
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,
        }
      : null,
  };
}

function mapProductDetailsDoc(item, lang) {
  // item is mongoose doc
  const obj = item.toObject();
  const now = new Date();
  const onSale = isSaleActiveByPrice(obj, now);

  return {
    ...obj,

    // ✅ Unified fields
    title: t(obj, "title", lang),
    description: t(obj, "description", lang),

    // ✅ Normalize sale output
    sale: onSale
      ? {
          salePrice: Number(obj.salePrice || 0),
          saleStartAt: obj.saleStartAt || null,
          saleEndAt: obj.saleEndAt || null,
        }
      : null,
  };
}

/* ============================================================================
   PRODUCTS LISTING (Filters + Pagination)
   GET /api/products?q&categoryId&minPrice&maxPrice&onSale&inStock&featured&sort&page&limit
============================================================================ */

router.get("/", async (req, res) => {
  try {
    const now = new Date();

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);

    const q = String(req.query.q || "").trim();
    const categoryId = String(req.query.categoryId || "").trim();
    const minPrice = req.query.minPrice != null ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice != null ? Number(req.query.maxPrice) : null;

    const onSale = String(req.query.onSale || "false") === "true";
    const inStock = String(req.query.inStock || "false") === "true";
    const featured = String(req.query.featured || "false") === "true";
    const sort = String(req.query.sort || "newest").trim();

    const filter = { isActive: true };

    // Search in titleHe/titleAr (safe regex)
    if (q) {
      const safe = escapeRegex(q);
      const regex = new RegExp(safe, "i");
      filter.$or = [{ titleHe: regex }, { titleAr: regex }, { title: regex }];
    }

    // Category filter
    if (categoryId) {
      if (!isValidObjectId(categoryId)) {
        throw makeErr(400, "VALIDATION_ERROR", "Invalid categoryId");
      }
      filter.categoryId = categoryId;
    }

    // Price range filters (base price)
    if (minPrice != null && !Number.isNaN(minPrice)) {
      filter.price = { ...(filter.price || {}), $gte: minPrice };
    }
    if (maxPrice != null && !Number.isNaN(maxPrice)) {
      filter.price = { ...(filter.price || {}), $lte: maxPrice };
    }

    // In stock filter
    if (inStock) {
      filter.stock = { $gt: 0 };
    }

    // Featured filter
    if (featured) {
      filter.isFeatured = true;
    }

    /**
     * ✅ On sale filter (prompt rule + date window)
     * salePrice exists AND salePrice < price
     * AND (saleStartAt null OR saleStartAt <= now)
     * AND (saleEndAt null OR saleEndAt >= now)
     */
    if (onSale) {
      filter.salePrice = { $ne: null };
      filter.$expr = { $lt: ["$salePrice", "$price"] };

      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [{ saleStartAt: null }, { saleStartAt: { $lte: now } }],
        },
        {
          $or: [{ saleEndAt: null }, { saleEndAt: { $gte: now } }],
        },
      ];
    }

    // Sort
    let sortOption = { createdAt: -1 };
    if (sort === "price_asc") sortOption = { price: 1 };
    else if (sort === "price_desc") sortOption = { price: -1 };

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(sortOption)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    const mapped = items.map((p) => mapProductListItem(p, req.lang, now));

    return res.json({
      ok: true,
      data: {
        items: mapped,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   PRODUCT DETAILS
   GET /api/products/:id
============================================================================ */

router.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const item = await Product.findById(id);
    if (!item || !item.isActive) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    return res.json({
      ok: true,
      data: mapProductDetailsDoc(item, req.lang),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   REVIEWS
   1) GET  /api/products/:id/reviews?page&limit
   2) POST /api/products/:id/reviews  (Protected)
============================================================================ */

const reviewsListSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  query: z
    .object({
      page: z.string().optional(),
      limit: z.string().optional(),
    })
    .optional(),
});

router.get("/:id/reviews", validate(reviewsListSchema), async (req, res) => {
  try {
    const productId = String(req.params.id || "");
    if (!isValidObjectId(productId)) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const exists = await Product.exists({ _id: productId, isActive: true });
    if (!exists) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);

    const [items, total, stats] = await Promise.all([
      Review.find({ productId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Review.countDocuments({ productId }),
      Review.aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(productId) } },
        { $group: { _id: null, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
    ]);

    const avgRatingRaw = stats?.[0]?.avgRating ?? 0;
    const count = stats?.[0]?.count ?? 0;

    return res.json({
      ok: true,
      data: {
        items: items.map((r) => ({
          id: r._id,
          _id: r._id,
          rating: Number(r.rating || 0),
          comment: r.comment || "",
          createdAt: r.createdAt,
          userId: r.userId, // keep minimal; safe enough
        })),
        avgRating: Math.round((Number(avgRatingRaw) + Number.EPSILON) * 10) / 10, // 1 decimal
        count,
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

const reviewCreateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(600).optional(),
  }),
});

/**
 * Rule:
 * - prevent multiple reviews per user per product
 * ✅ choose: update existing (better UX)
 */
router.post("/:id/reviews", requireAuth(), validate(reviewCreateSchema), async (req, res) => {
  try {
    const productId = String(req.params.id || "");
    if (!isValidObjectId(productId)) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const exists = await Product.exists({ _id: productId, isActive: true });
    if (!exists) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const { rating, comment } = req.validated.body;

    const updated = await Review.findOneAndUpdate(
      { productId, userId: req.user._id },
      {
        $set: {
          rating,
          comment: String(comment || "").trim(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    return res.status(201).json({
      ok: true,
      data: {
        id: updated._id,
        _id: updated._id,
        productId: updated.productId,
        userId: updated.userId,
        rating: updated.rating,
        comment: updated.comment || "",
        createdAt: updated.createdAt,
      },
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================================================================
   ADMIN CREATE / UPDATE / DELETE PRODUCTS
============================================================================ */
const createBodySchema = z
  .object({
    titleHe: z.string().min(2).max(160).optional(),
    titleAr: z.string().max(160).optional(),
    descriptionHe: z.string().max(4000).optional(),
    descriptionAr: z.string().max(4000).optional(),

    title: z.string().min(2).max(160).optional(),
    description: z.string().max(4000).optional(),

    price: z.number().min(0),
    stock: z.number().int().min(0),
    categoryId: z.string().min(1),

    imageUrl: z.string().optional(),
    isActive: z.boolean().optional(),

    isFeatured: z.boolean().optional(),
    isBestSeller: z.boolean().optional(),

    salePrice: z.number().min(0).nullable().optional(),
    discountPercent: z.number().min(0).max(100).nullable().optional(),
    saleStartAt: z.string().datetime().nullable().optional(),
    saleEndAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }

    // ✅ only validate this in CREATE (price is required here)
    if (b.salePrice != null && !(Number(b.salePrice) < Number(b.price))) {
      ctx.addIssue({
        code: "custom",
        path: ["salePrice"],
        message: "salePrice must be less than price to be considered on sale",
      });
    }
  });

const updateBodySchema = z
  .object({
    titleHe: z.string().min(2).max(160).optional(),
    titleAr: z.string().max(160).optional(),
    descriptionHe: z.string().max(4000).optional(),
    descriptionAr: z.string().max(4000).optional(),

    title: z.string().min(2).max(160).optional(),
    description: z.string().max(4000).optional(),

    price: z.number().min(0).optional(),
    stock: z.number().int().min(0).optional(),
    categoryId: z.string().min(1).optional(),

    imageUrl: z.string().optional(),
    isActive: z.boolean().optional(),

    isFeatured: z.boolean().optional(),
    isBestSeller: z.boolean().optional(),

    salePrice: z.number().min(0).nullable().optional(),
    discountPercent: z.number().min(0).max(100).nullable().optional(),
    saleStartAt: z.string().datetime().nullable().optional(),
    saleEndAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.categoryId && !isValidObjectId(b.categoryId)) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Invalid categoryId" });
    }

    // ✅ validate salePrice < price ONLY if both provided in update payload
    if (b.salePrice != null && b.price != null) {
      if (!(Number(b.salePrice) < Number(b.price))) {
        ctx.addIssue({
          code: "custom",
          path: ["salePrice"],
          message: "salePrice must be less than price to be considered on sale",
        });
      }
    }
  });

const createSchema = z.object({
  body: createBodySchema,
});


router.post("/", requireAuth(), requireRole("admin"), validate(createSchema), async (req, res) => {
  try {
    const b = req.validated.body;

    const item = await Product.create({
      titleHe: b.titleHe || b.title || "",
      titleAr: b.titleAr || "",
      descriptionHe: b.descriptionHe || b.description || "",
      descriptionAr: b.descriptionAr || "",

      // legacy fields (optional)
      title: b.title || b.titleHe || "",
      description: b.description || b.descriptionHe || "",

      price: b.price,
      stock: b.stock,
      categoryId: b.categoryId,
      imageUrl: b.imageUrl || "",

      isActive: b.isActive ?? true,
      isFeatured: b.isFeatured ?? false,
      isBestSeller: b.isBestSeller ?? false,

      salePrice: b.salePrice ?? null,
      discountPercent: b.discountPercent ?? null,
      saleStartAt: b.saleStartAt ? new Date(b.saleStartAt) : null,
      saleEndAt: b.saleEndAt ? new Date(b.saleEndAt) : null,
    });

    return res.status(201).json({
      ok: true,
      data: mapProductDetailsDoc(item, req.lang),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: updateBodySchema,
});

router.put(
  "/:id",
  requireAuth(),
  requireRole("admin"),
  validate(updateSchema),
  async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!isValidObjectId(id)) {
        return res.status(404).json({
          ok: false,
          error: { code: "NOT_FOUND", message: "Product not found" },
        });
      }

      const b = req.validated.body;
      const patch = { ...b };

      // Keep legacy synced if someone updates HE fields
      if (patch.titleHe && !patch.title) patch.title = patch.titleHe;
      if (patch.descriptionHe && !patch.description) patch.description = patch.descriptionHe;

      // ISO string -> Date
      if ("saleStartAt" in patch)
        patch.saleStartAt = patch.saleStartAt ? new Date(patch.saleStartAt) : null;
      if ("saleEndAt" in patch)
        patch.saleEndAt = patch.saleEndAt ? new Date(patch.saleEndAt) : null;

      // Normalize salePrice clearing
      if ("salePrice" in patch && patch.salePrice === undefined) delete patch.salePrice;

      const item = await Product.findByIdAndUpdate(id, patch, { new: true });
      if (!item) {
        return res.status(404).json({
          ok: false,
          error: { code: "NOT_FOUND", message: "Product not found" },
        });
      }

      return res.json({
        ok: true,
        data: mapProductDetailsDoc(item, req.lang),
      });
    } catch (e) {
      return jsonErr(res, e);
    }
  },
);

router.delete("/:id", requireAuth(), requireRole("admin"), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    const item = await Product.findByIdAndDelete(id);
    if (!item) {
      return res.status(404).json({
        ok: false,
        error: { code: "NOT_FOUND", message: "Product not found" },
      });
    }

    return res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
