// src/models/Product.js
import mongoose from "mongoose";

import { generateUniqueSlug } from "../utils/slug.js";

const { Schema } = mongoose;

/**
 * ============================
 * Product Image Schema (Multi-image support)
 * ============================
 */
const productImageSchema = new Schema(
  {
    // Optional reference to MediaAsset
    assetId: { type: Schema.Types.ObjectId, ref: "MediaAsset", default: null },

    // URL is required (can be external or from MediaAsset)
    url: { type: String, required: true, trim: true, maxlength: 512 },
    secureUrl: { type: String, default: "", trim: true, maxlength: 512 },

    // Alt text for accessibility (bilingual)
    altHe: { type: String, default: "", trim: true, maxlength: 256 },
    altAr: { type: String, default: "", trim: true, maxlength: 256 },

    // Primary image flag (exactly one should be true when images[] is not empty)
    isPrimary: { type: Boolean, default: false },

    // Sort order for gallery display
    sortOrder: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const variantAttributeSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ["text", "number", "enum"], required: true },
    value: { type: Schema.Types.Mixed, default: null },
    valueKey: { type: String, default: "", trim: true, maxlength: 80 },
    unit: { type: String, default: "", trim: true, maxlength: 20 },
  },
  { _id: false },
);

const variantSchema = new Schema(
  {
    variantKey: { type: String, default: "", trim: true, maxlength: 240 },
    // Optional identifiers
    sku: { type: String, default: "", trim: true, maxlength: 80 },
    barcode: { type: String, default: "", trim: true, maxlength: 80 },

    // Optional price override (ILS major/minor)
    priceOverride: { type: Number, default: null, min: 0 },
    priceOverrideMinor: { type: Number, default: null, min: 0 },

    // Required stock per variant
    stock: { type: Number, required: true, min: 0, default: 0 },

    // Dynamic attributes (catalog-driven)
    attributes: { type: [variantAttributeSchema], default: [] },

    // Legacy fixed fields (migration-safe)
    volumeMl: { type: Number, default: null, min: 0 },
    weightG: { type: Number, default: null, min: 0 },
    packCount: { type: Number, default: null, min: 0 },
    scent: { type: String, default: "", trim: true, maxlength: 80 },
    holdLevel: { type: String, default: "", trim: true, maxlength: 80 },
    finishType: { type: String, default: "", trim: true, maxlength: 80 },
    skinType: { type: String, default: "", trim: true, maxlength: 80 },
  },
  { _id: true },
);

/**
 * ============================
 * Product Stats (Server-Side Ranking)
 * ============================
 */
const productStatsSchema = new Schema(
  {
    soldCountAll: { type: Number, default: 0, min: 0 },
    soldCount30d: { type: Number, default: 0, min: 0 },
    views7d: { type: Number, default: 0, min: 0 },
    cartAdds30d: { type: Number, default: 0, min: 0 },
    wishlistAdds30d: { type: Number, default: 0, min: 0 },
    ratingAvg: { type: Number, default: 0, min: 0 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    // Bilingual fields (default language: Hebrew)
    titleHe: { type: String, required: true, trim: true, minlength: 2, maxlength: 160 },
    titleAr: { type: String, default: "", trim: true, maxlength: 160 },
    descriptionHe: { type: String, default: "", trim: true, maxlength: 4000 },
    descriptionAr: { type: String, default: "", trim: true, maxlength: 4000 },

    // Legacy fields (optional) - kept for backward compatibility
    title: { type: String, default: "", trim: true, maxlength: 160 },
    description: { type: String, default: "", trim: true, maxlength: 4000 },
    slug: { type: String, default: "", trim: true, lowercase: true, maxlength: 160 },

    // Money in major units (ILS)
    price: { type: Number, required: true, min: 0 },
    priceMinor: { type: Number, default: 0, min: 0 },

    // Stock must be integer
    stock: { type: Number, required: true, min: 0, default: 0 },

    // Inventory control
    trackInventory: { type: Boolean, default: true },
    allowBackorder: { type: Boolean, default: false },

    /**
     * ✅ Sale rule (ONLY):
     * salePrice exists AND salePrice < price AND within window (if provided)
     * discountPercent is DISPLAY-only (optional), NOT used in pricing truth.
     */
    salePrice: { type: Number, min: 0, default: null },
    salePriceMinor: { type: Number, default: null, min: 0 },
    discountPercent: { type: Number, min: 0, max: 100, default: null }, // badge only
    saleStartAt: { type: Date, default: null },
    saleEndAt: { type: Date, default: null },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },

    // Retail identity (optional)
    brand: { type: String, default: "", trim: true, maxlength: 120 },
    sku: { type: String, default: "", trim: true, maxlength: 80 },
    barcode: { type: String, default: "", trim: true, maxlength: 80 },
    sizeLabel: { type: String, default: "", trim: true, maxlength: 80 },
    unit: { type: String, enum: ["ml", "g", "pcs", "set", null], default: null },
    netQuantity: { type: Number, default: null, min: 0 },
    tags: { type: [String], default: [] },

    ingredients: { type: String, default: "", trim: true, maxlength: 4000 },
    usage: { type: String, default: "", trim: true, maxlength: 4000 },
    warnings: { type: String, default: "", trim: true, maxlength: 4000 },

    // Israel compliance (optional)
    manufacturerName: { type: String, default: "", trim: true, maxlength: 160 },
    importerName: { type: String, default: "", trim: true, maxlength: 160 },
    countryOfOrigin: { type: String, default: "", trim: true, maxlength: 120 },
    warrantyInfo: { type: String, default: "", trim: true, maxlength: 400 },

    // Legacy single image URL (backward compatible)
    imageUrl: { type: String, default: "" },

    // Multi-image support (new)
    images: {
      type: [productImageSchema],
      default: [],
      validate: {
        validator: function (arr) {
          return !arr || arr.length <= 10; // Max 10 images per product
        },
        message: "Maximum 10 images allowed per product",
      },
    },

    isActive: { type: Boolean, default: true },

    // Variants (optional)
    variants: { type: [variantSchema], default: [] },

    /**
     * @deprecated Use ranking endpoints instead. Manual flags violate NO MANUAL FLAGS store rule.
     * Featured/best-seller lists must be computed from real engagement data.
     * Kept for backward compatibility with admin panel; NOT exposed in public API.
     */
    isFeatured: { type: Boolean, default: false },
    /**
     * @deprecated Use ranking endpoints instead. Manual flags violate NO MANUAL FLAGS store rule.
     * Best-seller lists must be computed from real sales data (stats.soldCount30d).
     * Kept for backward compatibility with admin panel; NOT exposed in public API.
     */
    isBestSeller: { type: Boolean, default: false },

    // Server-side ranking stats (no client sorting)
    stats: { type: productStatsSchema, default: () => ({}) },

    // Soft delete flag
    isDeleted: { type: Boolean, default: false },

    // Soft delete timestamp (set when isDeleted becomes true)
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * ============================
 * Data Hygiene (Critical)
 * ============================
 * Prevent silent broken products & keep legacy synced.
 */
function toMinorSafe(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function normalizeKeyPart(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s ? s.replace(/\s+/g, "_") : "";
}

function normalizeKey(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
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

function normalizeVariantAttributes(attrs = []) {
  const out = [];
  for (const a of attrs || []) {
    if (!a) continue;
    const key = normalizeKey(a.key);
    if (!key) continue;
    const type = String(a.type || "")
      .trim()
      .toLowerCase();
    const valueKey = normalizeKey(a.valueKey);
    const unit = String(a.unit || "").trim();

    out.push({
      key,
      type,
      value: a.value ?? null,
      valueKey,
      unit,
    });
  }
  return out;
}

function buildVariantKeyFromAttributes(attributes) {
  if (!Array.isArray(attributes) || !attributes.length) return "";

  const parts = attributes
    .map((a) => {
      const key = normalizeKey(a.key);
      if (!key) return null;
      const rawVal = a.valueKey || a.value;
      if (rawVal == null) return null;
      const val = typeof rawVal === "string" ? normalizeKeyPart(rawVal) : String(rawVal);
      if (!val) return null;
      return { key, val };
    })
    .filter(Boolean)
    .sort((a, b) => (a.key === b.key ? a.val.localeCompare(b.val) : a.key.localeCompare(b.key)));

  return parts.map((p) => `${p.key}:${p.val}`).join("|");
}

productSchema.pre("validate", function productPreValidate(next) {
  const run = async () => {
    // Ensure slug is always present (auto-generated when missing/modified)
    if (this.isNew || this.isModified("slug") || !this.slug) {
      const baseInput =
        (typeof this.slug === "string" ? this.slug.trim() : "") ||
        this.titleHe ||
        this.title ||
        this._id?.toString() ||
        Date.now().toString();
      this.slug = await generateUniqueSlug(this.constructor, baseInput, this._id);
    }

    // Sync legacy title/description so old UI code doesn't break
    if (!this.title) this.title = this.titleHe || "";
    if (!this.description) this.description = this.descriptionHe || "";

    // Ensure integers for stock (defensive)
    if (Number.isFinite(this.stock)) this.stock = Math.max(0, Math.trunc(this.stock));

    // Normalize empty strings -> null for sale dates
    if (!this.saleStartAt) this.saleStartAt = null;
    if (!this.saleEndAt) this.saleEndAt = null;

    // If both dates exist, enforce start <= end
    if (this.saleStartAt && this.saleEndAt && this.saleStartAt > this.saleEndAt) {
      return next(new Error("saleStartAt must be <= saleEndAt"));
    }

    // Enforce salePrice < price if salePrice provided
    // If invalid, we null it out to avoid fake "onSale"
    if (this.salePrice != null) {
      const price = Number(this.price || 0);
      const sale = Number(this.salePrice || 0);

      if (!(sale < price)) {
        this.salePrice = null;
        this.discountPercent = null;
        this.saleStartAt = null;
        this.saleEndAt = null;
      }
    }

    // Keep minor units in sync (major is canonical for input)
    this.priceMinor = toMinorSafe(this.price);
    if (this.salePrice != null) {
      this.salePriceMinor = toMinorSafe(this.salePrice);
    } else {
      this.salePriceMinor = null;
    }

    // Images normalization: ensure exactly one primary when images[] is not empty
    if (Array.isArray(this.images) && this.images.length > 0) {
      // Sort by sortOrder
      this.images.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

      // Check if any image is marked as primary
      const hasPrimary = this.images.some((img) => img.isPrimary === true);

      if (!hasPrimary) {
        // Auto-set the first image as primary
        this.images[0].isPrimary = true;
      } else {
        // Ensure only ONE image is primary (first one wins)
        let foundPrimary = false;
        for (const img of this.images) {
          if (img.isPrimary === true) {
            if (foundPrimary) {
              img.isPrimary = false;
            } else {
              foundPrimary = true;
            }
          }
        }
      }

      // Sync legacy imageUrl with primary image if not already set
      const primaryImage = this.images.find((img) => img.isPrimary);
      if (primaryImage && !this.imageUrl) {
        this.imageUrl = primaryImage.secureUrl || primaryImage.url || "";
      }
    }

    // Variants normalization
    if (Array.isArray(this.variants)) {
      const keySeen = new Set();
      const skuSeen = new Set();

      this.variants.forEach((v) => {
        if (!v) return;
        if (Number.isFinite(v.stock)) v.stock = Math.max(0, Math.trunc(v.stock));

        if (v.priceOverride != null) {
          v.priceOverrideMinor = toMinorSafe(v.priceOverride);
        } else {
          v.priceOverrideMinor = null;
        }

        const attrs = normalizeVariantAttributes(v.attributes || []);
        const legacyAttrs = buildLegacyAttributes(v);
        const merged = [...attrs];
        const keys = new Set(attrs.map((a) => a.key));
        for (const la of legacyAttrs) {
          if (!keys.has(la.key)) merged.push(la);
        }

        v.attributes = merged;

        const key = buildVariantKeyFromAttributes(merged);
        v.variantKey = key || "";

        if (key) {
          if (keySeen.has(key)) {
            throw new Error("Duplicate variantKey within product");
          }
          keySeen.add(key);
        }

        const attrKeySeen = new Set();
        for (const a of merged) {
          if (attrKeySeen.has(a.key)) {
            throw new Error("Duplicate attribute key within variant");
          }
          attrKeySeen.add(a.key);
        }

        const sku = String(v.sku || "")
          .trim()
          .toLowerCase();
        if (sku) {
          if (skuSeen.has(sku)) {
            throw new Error("Duplicate variant sku within product");
          }
          skuSeen.add(sku);
        }
      });
    }

    return next();
  };

  run().catch((err) => next(err));
});

/**
 * ============================
 * Indexes
 * ============================
 */

// ✅ ONE text index only (MongoDB limitation)
productSchema.index(
  {
    titleHe: "text",
    titleAr: "text",
    title: "text",
  },
  {
    weights: {
      titleHe: 5,
      titleAr: 5,
      title: 2,
    },
    name: "ProductTextIndex",
  },
);

// Unique slug guard (only enforce once slug is populated)
productSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: "string", $ne: "" } } }
);

// Fast listing (active products)
productSchema.index({ isActive: 1, createdAt: -1 });

// Compound index for soft-delete aware queries (admin + public)
productSchema.index({ isActive: 1, isDeleted: 1, createdAt: -1 });

// Optional SKU uniqueness when provided
productSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: "string", $ne: "" } } },
);

// Filters/sorting
productSchema.index({ categoryId: 1, createdAt: -1 });
productSchema.index({ isActive: 1, stock: 1 });

// Ranking indexes (category-specific for filtered queries)
productSchema.index({ categoryId: 1, "stats.soldCount30d": -1, createdAt: -1 });
productSchema.index({ categoryId: 1, "stats.views7d": -1, createdAt: -1 });
productSchema.index({ categoryId: 1, "stats.ratingAvg": -1, "stats.ratingCount": -1, createdAt: -1 });

// Ranking indexes (global for unfiltered queries)
productSchema.index({ "stats.soldCount30d": -1, createdAt: -1 });
productSchema.index({ "stats.views7d": -1, createdAt: -1 });
productSchema.index({ "stats.ratingAvg": -1, "stats.ratingCount": -1, createdAt: -1 });

// ✅ Helps onSale queries (still needs $expr in queries)
productSchema.index({ salePrice: 1, price: 1, saleStartAt: 1, saleEndAt: 1 });

export const Product = mongoose.model("Product", productSchema);
