// src/routes/wishlist.routes.js

import express from "express";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { User } from "../models/User.js";
import { Product } from "../models/Product.js";
import { mapProductListItem } from "../utils/mapProduct.js";
import { getRequestId } from "../middleware/error.js";
import { recordProductEngagement } from "../services/ranking.service.js";

const router = express.Router();

function errorPayload(req, code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

// Fields to select for wishlist products (matches product listing shape)
// NOTE: isFeatured/isBestSeller removed - rankings use computed data, not manual flags.
const WISHLIST_PRODUCT_FIELDS = [
  "_id", "title", "titleHe", "titleAr",
  "description", "descriptionHe", "descriptionAr",
  "price", "priceMinor", "salePrice", "salePriceMinor",
  "saleStartAt", "saleEndAt", "discountPercent",
  "stock", "categoryId", "imageUrl", "images",
  "isActive",
  "brand", "sku", "barcode", "sizeLabel",
  "unit", "netQuantity", "tags", "slug"
].join(" ");

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
    .select(WISHLIST_PRODUCT_FIELDS)
    .lean();

  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const now = new Date();

  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => mapProductListItem(p, { lang: req.lang, now }));

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
    return res.status(404).json(errorPayload(req, "PRODUCT_NOT_FOUND", "Product not found"));
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

  if (!exists) {
    // ✅ Track wishlist add (best-effort, abuse-protected)
    recordProductEngagement({
      productId,
      type: "wishlist",
      userId: req.user?._id || null,
      ip: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
      now: new Date(),
    }).catch(() => {});
  }

  // Return updated wishlist items (same output as GET)
  const updated = await User.findById(req.user._id).select("wishlist").lean();
  const ids = (updated?.wishlist || []).map((x) => x.toString());

  if (!ids.length) {
    return res.json({ ok: true, data: { items: [] } });
  }

  const products = await Product.find({ _id: { $in: ids }, isActive: true })
    .select(WISHLIST_PRODUCT_FIELDS)
    .lean();

  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const now = new Date();

  const items = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => mapProductListItem(p, { lang: req.lang, now }));

  return res.json({ ok: true, data: { items } });
});

export default router;
