import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const ProductSchema = new Schema(
  {
    nameHe: { type: String, trim: true, maxlength: 180, required: true },
    nameAr: { type: String, trim: true, maxlength: 180 },
    descriptionHe: { type: String, trim: true, maxlength: 30_000 },
    descriptionAr: { type: String, trim: true, maxlength: 30_000 },

    brand: { type: String, trim: true, maxlength: 140, index: true },

    categoryIds: { type: [Types.ObjectId], ref: "Category", default: [], index: true },

    images: { type: [String], default: [] }, // URLs
    isActive: { type: Boolean, default: true, index: true },
    inStock: { type: Boolean, default: false, index: true },

    // Denormalized review stats (avoid per-request $lookup)
    reviewsCount: { type: Number, default: 0 },
    ratingAvg: { type: Number, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    attributes: { type: Map, of: Schema.Types.Mixed, default: {} },

    slug: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true, strict: true },
);

const NOT_DELETED = { isDeleted: { $ne: true } };

ProductSchema.index({ isActive: 1, createdAt: -1 }, { partialFilterExpression: NOT_DELETED });
ProductSchema.index({ categoryIds: 1, isActive: 1 }, { partialFilterExpression: NOT_DELETED });
ProductSchema.index({ brand: 1, isActive: 1 }, { partialFilterExpression: NOT_DELETED });
ProductSchema.index({ slug: 1 }, { sparse: true, partialFilterExpression: NOT_DELETED });
ProductSchema.index(
  { reviewsCount: -1, ratingAvg: -1, createdAt: -1 },
  { partialFilterExpression: NOT_DELETED },
);

// Full-text search for name/brand (fallback to regex only when needed)
ProductSchema.index(
  { nameHe: "text", nameAr: "text", brand: "text" },
  { weights: { nameHe: 10, nameAr: 10, brand: 3 }, partialFilterExpression: NOT_DELETED },
);

// (اختياري) بحث نصي بسيط — فعّله إذا لن تستخدم Atlas Search الآن
// ProductSchema.index(
//   { nameHe: "text", nameAr: "text", brand: "text" },
//   { weights: { nameHe: 10, nameAr: 10, brand: 3 } }
// );

baseToJSON(ProductSchema);

export const Product = getOrCreateModel("Product", ProductSchema);
export default Product;
