// src/routes/wishlist.routes.js

import express from "express";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { User } from "../models/User.js";
import { Product } from "../models/Product.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

function isSaleActive(p, now = new Date()) {
  if (p.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < p.saleStartAt) return false;
  if (p.saleEndAt && now > p.saleEndAt) return false;
  return true;
}

function mapProductCard(p, lang, now = new Date()) {
  const onSale = isSaleActive(p, now);
  return {
    id: p._id,
    _id: p._id, // additive

    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    title: t(p, "title", lang),

    price: p.price,
    salePrice: onSale ? p.salePrice : null,

    imageUrl: p.imageUrl || "",
    isActive: p.isActive ?? true,
    stock: p.stock ?? 0,

    categoryId: p.categoryId,
    isFeatured: Boolean(p.isFeatured),
    isBestSeller: Boolean(p.isBestSeller),

    sale: onSale
      ? {
          salePrice: p.salePrice,
          saleStartAt: p.saleStartAt,
          saleEndAt: p.saleEndAt,
        }
      : null,
  };
}

/**
 * GET /api/wishlist?lang=he|ar
 * Protected
 * Returns: { items:[...] } product cards with unified title/image/price.
 */
router.get("/", requireAuth(), async (req, res) => {
  const user = await User.findById(req.user._id).select("wishlist").lean();
  const ids = (user?.wishlist || []).map((x) => x.toString());

  if (!ids.length) {
    return res.json({ ok: true, data: { items: [] } });
  }

  // Keep original order as saved in wishlist
  const products = await Product.find({ _id: { $in: ids }, isActive: true })
    .select(
      "_id title titleHe titleAr price salePrice saleStartAt saleEndAt stock categoryId imageUrl isFeatured isBestSeller isActive",
    )
    .lean();

  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const now = new Date();

  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => mapProductCard(p, req.lang, now));

  return res.json({ ok: true, data: { items } });
});

const toggleSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
  }),
});

/**
 * POST /api/wishlist/toggle?lang=he|ar
 * Protected
 * Body: { productId }
 * Returns: { items:[...] } product cards
 */
router.post("/toggle", requireAuth(), validate(toggleSchema), async (req, res) => {
  const { productId } = req.validated.body;

  // Validate product exists + active
  const product = await Product.findOne({ _id: productId, isActive: true }).select("_id").lean();
  if (!product) {
    return res.status(404).json({
      ok: false,
      error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" },
    });
  }

  // Toggle atomically
  const user = await User.findById(req.user._id).select("wishlist").lean();
  const current = new Set((user?.wishlist || []).map((x) => x.toString()));
  const exists = current.has(productId);

  if (exists) {
    await User.updateOne({ _id: req.user._id }, { $pull: { wishlist: productId } });
  } else {
    await User.updateOne({ _id: req.user._id }, { $addToSet: { wishlist: productId } });
  }

  // Return updated wishlist items (same output as GET)
  const updated = await User.findById(req.user._id).select("wishlist").lean();
  const ids = (updated?.wishlist || []).map((x) => x.toString());

  if (!ids.length) {
    return res.json({ ok: true, data: { items: [] } });
  }

  const products = await Product.find({ _id: { $in: ids }, isActive: true })
    .select(
      "_id title titleHe titleAr price salePrice saleStartAt saleEndAt stock categoryId imageUrl isFeatured isBestSeller isActive",
    )
    .lean();

  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const now = new Date();

  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => mapProductCard(p, req.lang, now));

  return res.json({ ok: true, data: { items } });
});

export default router;
