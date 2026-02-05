// src/routes/cart.guest.routes.js
// Guest cart - no auth required. Uses cartId from cookie (guest_cart_id) or header (x-guest-cart-id).
import express from "express";
import { z } from "zod";

import { validate } from "../middleware/validate.js";
import { GuestCart } from "../models/GuestCart.js";
import { Product } from "../models/Product.js";
import { computeEffectiveUnitPriceMinor } from "../services/pricing.service.js";
import { getRequestId } from "../middleware/error.js";
import { mapCartProductDTO } from "../utils/mapProduct.js";
import {
  getGuestCartIdFromRequest,
  getOrCreateGuestCart,
  getGuestCartCookieOptions,
} from "../services/guestCart.service.js";

const router = express.Router();

function errorPayload(req, code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
      ...(details ? { details } : {}),
    },
  };
}

function fromMinor(minor) {
  const n = Number(minor || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function normalizeKey(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  return v.replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
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

async function getPopulatedGuestCart(items, { lang = "he" } = {}) {
  if (!items?.length) return [];
  const ids = [...new Set(items.map((x) => x.productId).filter(Boolean))];
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const now = new Date();
  const result = [];
  for (const ci of items) {
    const p = byId.get(String(ci.productId));
    if (!p || !p._id || p.isActive === false || p.isDeleted === true) continue;
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const variantIdStr = String(ci.variantId || "");
    const variant = hasVariants ? p.variants.find((v) => String(v?._id) === variantIdStr) : null;
    if (hasVariants && variantIdStr && !variant) continue;
    const currentUnitMinor = computeEffectiveUnitPriceMinor(p, variant, now);
    const currentStock = hasVariants ? (variant?.stock ?? 0) : (p.stock ?? 0);
    result.push({
      product: mapCartProductDTO(p, { lang, now }),
      qty: ci.qty,
      variantId: variantIdStr,
      variantSnapshot: ci.variantSnapshot || null,
      currentUnitPrice: fromMinor(currentUnitMinor),
      currentUnitPriceMinor: Math.max(0, Math.round(currentUnitMinor)),
      currentStock,
      isAvailable: currentStock > 0,
      lineTotal: fromMinor(currentUnitMinor * ci.qty),
      lineTotalMinor: Math.max(0, Math.round(currentUnitMinor * ci.qty)),
    });
  }
  return result;
}

function setCartIdCookie(res, cartId) {
  const opts = getGuestCartCookieOptions();
  res.cookie("guest_cart_id", cartId, opts);
}

/** GET /guest - Get guest cart. Requires cartId in cookie or x-guest-cart-id header. */
router.get("/", async (req, res) => {
  try {
    const cartId = getGuestCartIdFromRequest(req);
    const result = await getOrCreateGuestCart(cartId);
    if (!result) {
      return res.json({ ok: true, data: [], cartId: null });
    }
    const populated = await getPopulatedGuestCart(result.cart.items, { lang: req.lang });
    return res.json({ ok: true, data: populated, cartId: result.cartId });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to fetch guest cart"));
  }
});

const guestAddSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
    variantId: z.string().min(1).optional(),
    guestCartId: z.string().optional(),
  }),
});

/** POST /guest/add - Add to guest cart. Creates cart if needed. */
router.post("/add", validate(guestAddSchema), async (req, res) => {
  try {
    const cartId =
      getGuestCartIdFromRequest(req) || req.validated?.body?.guestCartId;
    const result = await getOrCreateGuestCart(cartId, { createIfMissing: true });
    if (!result) {
      return res.status(400).json(errorPayload(req, "CART_ID_REQUIRED", "guestCartId or cookie required"));
    }

    const { productId, qty, variantId } = req.validated.body;
    const product = await Product.findById(productId);
    if (!product || product.isActive === false || product.isDeleted === true) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Product not found"));
    }

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    if (hasVariants && !variantId) {
      return res.status(400).json(
        errorPayload(req, "VARIANT_REQUIRED", "variantId is required for this product", { productId })
      );
    }

    const variant = hasVariants
      ? product.variants.find((v) => String(v?._id) === String(variantId))
      : null;
    if (hasVariants && !variant) {
      return res.status(400).json(
        errorPayload(req, "INVALID_VARIANT", "Invalid variantId", { productId, variantId })
      );
    }

    const idMatch = String(variant?._id || "");
    const doc = await GuestCart.findOne({ cartId: result.cartId });
    if (!doc) {
      return res.status(404).json(errorPayload(req, "CART_NOT_FOUND", "Guest cart not found"));
    }

    const idx = doc.items.findIndex(
      (x) =>
        String(x.productId) === productId &&
        String(x.variantId || "") === idMatch
    );

    const now = new Date();
    const unitMinor = computeEffectiveUnitPriceMinor(product, variant, now);
    const attributesList = variant ? normalizeAttributesList(variant) : [];

    if (idx >= 0) {
      doc.items[idx].qty = Math.min(999, (doc.items[idx].qty || 0) + qty);
    } else {
      doc.items.push({
        productId,
        qty,
        variantId: idMatch,
        variantSnapshot: variant
          ? {
              variantId: idMatch,
              sku: String(variant?.sku || ""),
              price: fromMinor(unitMinor),
              priceMinor: Math.max(0, Math.round(unitMinor)),
              attributesList,
              attributes: legacyAttributesObject(attributesList),
            }
          : null,
      });
    }
    doc.updatedAt = new Date();
    await doc.save();

    const populated = await getPopulatedGuestCart(doc.items, { lang: req.lang });
    const json = res.json({ ok: true, data: populated, cartId: result.cartId });
    setCartIdCookie(res, result.cartId);
    return json;
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to add to guest cart"));
  }
});

const guestSetQtySchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
    variantId: z.string().min(1).optional(),
  }),
});

/** POST /guest/set-qty */
router.post("/set-qty", validate(guestSetQtySchema), async (req, res) => {
  try {
    const cartId = getGuestCartIdFromRequest(req);
    const result = await getOrCreateGuestCart(cartId);
    if (!result) {
      return res.status(400).json(errorPayload(req, "CART_ID_REQUIRED", "guestCartId or cookie required"));
    }

    const { productId, qty, variantId } = req.validated.body;
    const product = await Product.findById(productId);
    if (!product || product.isActive === false || product.isDeleted === true) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Product not found"));
    }

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    const targetVariantId = hasVariants ? String(variantId || "") : "";
    if (hasVariants && !variantId) {
      return res.status(400).json(
        errorPayload(req, "VARIANT_REQUIRED", "variantId is required for this product", { productId })
      );
    }

    const doc = await GuestCart.findOne({ cartId: result.cartId });
    if (!doc) return res.status(404).json(errorPayload(req, "CART_NOT_FOUND", "Guest cart not found"));

    const idx = doc.items.findIndex(
      (x) =>
        String(x.productId) === productId &&
        (!hasVariants || String(x.variantId || "") === targetVariantId)
    );
    if (idx < 0) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Item not found in cart"));
    }

    doc.items[idx].qty = qty;
    doc.updatedAt = new Date();
    await doc.save();

    const populated = await getPopulatedGuestCart(doc.items, { lang: req.lang });
    return res.json({ ok: true, data: populated, cartId: result.cartId });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to update guest cart"));
  }
});

const guestRemoveSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    variantId: z.string().min(1).optional(),
  }),
});

/** POST /guest/remove */
router.post("/remove", validate(guestRemoveSchema), async (req, res) => {
  try {
    const cartId = getGuestCartIdFromRequest(req);
    const result = await getOrCreateGuestCart(cartId);
    if (!result) {
      return res.json({ ok: true, data: [], cartId: null });
    }

    const { productId, variantId } = req.validated.body;
    const doc = await GuestCart.findOne({ cartId: result.cartId });
    if (!doc) return res.json({ ok: true, data: [], cartId: result.cartId });

    const matchingLines = doc.items.filter((x) => String(x.productId) === productId);
    const hasVariantLines = matchingLines.some((x) => String(x.variantId || "").trim() !== "");
    if (hasVariantLines && !variantId) {
      return res.status(400).json(
        errorPayload(req, "VARIANT_REQUIRED", "variantId is required when removing variant products", {
          productId,
        })
      );
    }

    if (variantId) {
      doc.items = doc.items.filter(
        (x) =>
          String(x.productId) !== productId ||
          String(x.variantId || "") !== String(variantId)
      );
    } else {
      doc.items = doc.items.filter((x) => String(x.productId) !== productId);
    }
    doc.updatedAt = new Date();
    await doc.save();

    const populated = await getPopulatedGuestCart(doc.items, { lang: req.lang });
    return res.json({ ok: true, data: populated, cartId: result.cartId });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to remove from guest cart"));
  }
});

/** POST /guest/clear */
router.post("/clear", async (req, res) => {
  try {
    const cartId = getGuestCartIdFromRequest(req);
    const result = await getOrCreateGuestCart(cartId);
    if (!result) return res.json({ ok: true, data: [], cartId: null });

    await GuestCart.updateOne(
      { cartId: result.cartId },
      { $set: { items: [], updatedAt: new Date() } }
    );
    return res.json({ ok: true, data: [], cartId: result.cartId });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to clear guest cart"));
  }
});

export default router;
