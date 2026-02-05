// src/routes/cart.routes.js
import express from "express";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import cartGuestRoutes from "./cart.guest.routes.js";
import { User } from "../models/User.js";
import { Product } from "../models/Product.js";
import { computeEffectiveUnitPriceMinor } from "../services/pricing.service.js";
import { getRequestId } from "../middleware/error.js";
import { mapCartProductDTO } from "../utils/mapProduct.js";
import { recordProductEngagement } from "../services/ranking.service.js";

const router = express.Router();

/** =========================
 * Helpers
 * ========================= */

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
 * Helper to fetch populated cart with computed fields
 * Returns consistent cart data for all endpoints
 *
 * ✅ Includes best-effort cleanup:
 * - Removes cart lines where product was deleted OR became inactive
 * - Removes cart lines where variantId exists but variant was deleted
 * ✅ Returns mapped product DTO instead of raw mongoose document
 */
async function getPopulatedCart(userId, { lang = "he" } = {}) {
  const user = await User.findById(userId).populate("cart.productId");
  if (!user) return [];

  const now = new Date();

  const keep = [];
  const populated = [];

  for (const ci of user.cart || []) {
    const p = ci.productId;

    // Product missing, inactive, or deleted => drop line
    if (!p || !p._id || p.isActive === false || p.isDeleted === true) {
      continue;
    }

    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
    const variantIdStr = String(ci.variantId || "");

    // Find current variant
    const variant = hasVariants
      ? p.variants.find((v) => String(v?._id || "") === variantIdStr)
      : null;

    // Variant deleted but cart line references it => drop line
    if (hasVariants && variantIdStr && !variant) {
      continue;
    }

    // Keep original cart line (still valid)
    keep.push(ci);

    // Compute effective unit price
    const currentUnitMinor = computeEffectiveUnitPriceMinor(p, variant, now);
    const currentUnitPrice = fromMinor(currentUnitMinor);

    // Compute stock
    const currentStock = hasVariants ? variant?.stock ?? 0 : p.stock ?? 0;

    populated.push({
      // ✅ Map product to DTO instead of raw mongoose doc
      product: mapCartProductDTO(p, { lang, now }),
      qty: ci.qty,
      variantId: variantIdStr,
      variantSnapshot: ci.variantSnapshot || null,

      // Computed fields for frontend convenience
      currentUnitPrice,
      currentUnitPriceMinor: Math.max(0, Math.round(currentUnitMinor)),
      currentStock,
      isAvailable: currentStock > 0,

      // Line totals
      lineTotal: fromMinor(currentUnitMinor * ci.qty),
      lineTotalMinor: Math.max(0, Math.round(currentUnitMinor * ci.qty)),
    });
  }

  // Best-effort cleanup write (only if we dropped something)
  if ((user.cart || []).length !== keep.length) {
    user.cart = keep;
    await user.save({ validateBeforeSave: false }).catch(() => {});
  }

  return populated;
}

/** =========================
 * Routes
 * ========================= */

// Guest cart (no auth) - must be before "/" to avoid conflict
router.use("/guest", cartGuestRoutes);

router.get("/", requireAuth(), async (req, res) => {
  try {
    const items = await getPopulatedCart(req.user._id, { lang: req.lang });
    return res.json({ ok: true, data: items });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to fetch cart"));
  }
});

const addSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
    variantId: z.string().min(1).optional(),
    // If true, sets qty instead of adding (prevents double-add on auth redirect)
    idempotent: z.boolean().optional(),
    // If true, reject add when product is out of stock or qty exceeds available stock
    validateStock: z.boolean().optional(),
  }),
});

router.post("/add", requireAuth(), validate(addSchema), async (req, res) => {
  try {
    const { productId, qty, variantId, idempotent, validateStock } = req.validated.body;

    const product = await Product.findById(productId);
    if (!product || product.isActive === false || product.isDeleted === true) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Product not found"));
    }

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

    if (hasVariants && !variantId) {
      return res.status(400).json(
        errorPayload(req, "VARIANT_REQUIRED", "variantId is required for this product", {
          productId,
        })
      );
    }

    const variant = hasVariants
      ? product.variants.find((v) => String(v?._id || "") === String(variantId))
      : null;

    if (hasVariants && !variant) {
      return res.status(400).json(
        errorPayload(req, "INVALID_VARIANT", "Invalid variantId", { productId, variantId })
      );
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "Unauthorized"));
    }

    const idMatch = String(variant?._id || "");
    const idx = user.cart.findIndex(
      (x) =>
        x.productId.toString() === productId &&
        String(x.variantId || "") === String(idMatch || "")
    );

    const currentStock = hasVariants ? (variant?.stock ?? 0) : (product.stock ?? 0);
    if (validateStock && currentStock <= 0) {
      return res.status(409).json(
        errorPayload(req, "OUT_OF_STOCK", "Product is out of stock", {
          productId,
          variantId: idMatch || undefined,
          available: 0,
          requested: qty,
        })
      );
    }
    if (validateStock && currentStock > 0) {
      const existingQty = idx >= 0 ? (user.cart[idx].qty || 0) : 0;
      const effectiveQty = idempotent ? qty : existingQty + qty;
      if (effectiveQty > currentStock) {
        return res.status(409).json(
          errorPayload(req, "OUT_OF_STOCK_PARTIAL", "Requested quantity exceeds available stock", {
            productId,
            variantId: idMatch || undefined,
            available: currentStock,
            requested: effectiveQty,
          })
        );
      }
    }

    if (idx >= 0) {
      // If idempotent=true, set qty directly (prevents double-add on auth redirect)
      // Otherwise, add to existing qty (default behavior)
      user.cart[idx].qty = idempotent
        ? Math.min(qty, 999)
        : Math.min((user.cart[idx].qty || 0) + qty, 999);
    } else {
      const now = new Date();
      const unitMinor = computeEffectiveUnitPriceMinor(product, variant, now);
      const attributesList = variant ? normalizeAttributesList(variant) : [];

      user.cart.push({
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
              attributes: {
                ...legacyAttributesObject(attributesList),
              },
            }
          : null,
      });
    }

    await user.save();

    // ✅ Track cart add (best-effort, abuse-protected)
    recordProductEngagement({
      productId,
      type: "add_to_cart",
      userId: req.user?._id || null,
      ip: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
      now: new Date(),
    }).catch(() => {});

    const populatedCart = await getPopulatedCart(req.user._id, { lang: req.lang });
    return res.json({ ok: true, data: populatedCart });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to add item to cart"));
  }
});

const setQtySchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    qty: z.number().int().min(1).max(999),
    variantId: z.string().min(1).optional(),
  }),
});

router.post("/set-qty", requireAuth(), validate(setQtySchema), async (req, res) => {
  try {
    const { productId, qty, variantId } = req.validated.body;

    const product = await Product.findById(productId);
    if (!product || product.isActive === false || product.isDeleted === true) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Product not found"));
    }

    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

    // Variant enforcement for variant products only
    if (hasVariants) {
      if (!variantId) {
        return res.status(400).json(
          errorPayload(req, "VARIANT_REQUIRED", "variantId is required for this product", {
            productId,
          })
        );
      }
      const variant = product.variants.find((v) => String(v?._id || "") === String(variantId));
      if (!variant) {
        return res.status(400).json(
          errorPayload(req, "INVALID_VARIANT", "Invalid variantId", { productId, variantId })
        );
      }
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "Unauthorized"));
    }

    // Matching must ignore variantId when product has NO variants
    const targetVariantId = hasVariants ? String(variantId || "") : "";
    const idx = user.cart.findIndex(
      (x) =>
        x.productId.toString() === productId &&
        (!hasVariants || String(x.variantId || "") === targetVariantId)
    );

    if (idx < 0) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Item not found in cart"));
    }

    user.cart[idx].qty = qty;
    await user.save();

    const populatedCart = await getPopulatedCart(req.user._id, { lang: req.lang });
    return res.json({ ok: true, data: populatedCart });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to update cart quantity"));
  }
});

const removeSchema = z.object({
  body: z.object({
    productId: z.string().min(1),
    variantId: z.string().min(1).optional(),
  }),
});

/**
 * ✅ IMPORTANT FIX:
 * - Do NOT depend on Product.findById() here.
 * - Allows removing cart lines even if product/variant was deleted or became inactive.
 * - Prevents "stuck cart items" UX.
 * - For variant products (cart lines with variantId), variantId is required to remove a specific variant.
 */
router.post("/remove", requireAuth(), validate(removeSchema), async (req, res) => {
  try {
    const { productId, variantId } = req.validated.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "Unauthorized"));
    }

    const matchingLines = user.cart.filter((x) => x.productId.toString() === productId);
    const hasVariantLines = matchingLines.some((x) => String(x.variantId || "").trim() !== "");
    if (hasVariantLines && !variantId) {
      return res.status(400).json(
        errorPayload(req, "VARIANT_REQUIRED", "variantId is required when removing variant products", {
          productId,
        })
      );
    }

    const before = user.cart.length;

    if (variantId) {
      user.cart = user.cart.filter(
        (x) =>
          x.productId.toString() !== productId ||
          String(x.variantId || "") !== String(variantId)
      );
    } else {
      user.cart = user.cart.filter((x) => x.productId.toString() !== productId);
    }

    // If nothing changed, still return a consistent payload
    if (user.cart.length !== before) {
      await user.save();
    }

    const populatedCart = await getPopulatedCart(req.user._id, { lang: req.lang });
    return res.json({ ok: true, data: populatedCart });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to remove item from cart"));
  }
});

router.post("/clear", requireAuth(), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "Unauthorized"));
    }
    user.cart = [];
    await user.save();
    return res.json({ ok: true, data: [] });
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL", "Failed to clear cart"));
  }
});

export default router;
