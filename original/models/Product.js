// src/models/Product.js
import mongoose from "mongoose";

const { Schema } = mongoose;

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

    // Money in major units (ILS)
    price: { type: Number, required: true, min: 0 },

    // Stock must be integer
    stock: { type: Number, required: true, min: 0, default: 0 },

    /**
     * ✅ Sale rule (ONLY):
     * salePrice exists AND salePrice < price AND within window (if provided)
     * discountPercent is DISPLAY-only (optional), NOT used in pricing truth.
     */
    salePrice: { type: Number, min: 0, default: null },
    discountPercent: { type: Number, min: 0, max: 100, default: null }, // badge only
    saleStartAt: { type: Date, default: null },
    saleEndAt: { type: Date, default: null },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true, index: true },

    imageUrl: { type: String, default: "" },

    isActive: { type: Boolean, default: true, index: true },

    // Homepage flags
    isFeatured: { type: Boolean, default: false, index: true },
    isBestSeller: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

/**
 * ============================
 * Data Hygiene (Critical)
 * ============================
 * Prevent silent broken products & keep legacy synced.
 */
productSchema.pre("validate", function productPreValidate(next) {
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

  return next();
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
    descriptionHe: "text",
    descriptionAr: "text",
    description: "text",
  },
  {
    weights: {
      titleHe: 10,
      titleAr: 10,
      title: 6,
      descriptionHe: 3,
      descriptionAr: 3,
      description: 2,
    },
    name: "product_text_search",
  },
);

// Fast listing
productSchema.index({ isActive: 1, createdAt: -1 });

// Filters/sorting
productSchema.index({ categoryId: 1, createdAt: -1 });
productSchema.index({ isFeatured: 1, createdAt: -1 });
productSchema.index({ isBestSeller: 1, createdAt: -1 });
productSchema.index({ isActive: 1, stock: 1 });

// ✅ Helps onSale queries (still needs $expr in queries)
productSchema.index({ salePrice: 1, price: 1, saleStartAt: 1, saleEndAt: 1 });

export const Product = mongoose.model("Product", productSchema);
