import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

// slug: hair-clippers
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// fullSlug: tools/hair-clippers
const FULL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

const CategorySchema = new Schema(
  {
    nameHe: { type: String, trim: true, maxlength: 140, required: true },
    nameAr: { type: String, trim: true, maxlength: 140 },

    slug: { type: String, trim: true, maxlength: 160, required: true, match: SLUG_RE },
    fullSlug: { type: String, trim: true, maxlength: 400, required: true, match: FULL_SLUG_RE },

    image: { type: String, trim: true, maxlength: 800, default: "" }, // optional URL

    parentId: { type: Types.ObjectId, ref: "Category", default: null, index: true },
    ancestors: { type: [Types.ObjectId], ref: "Category", default: [], index: true },
    level: { type: Number, default: 0, min: 0, index: true },

    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);

const NOT_DELETED = { isDeleted: { $ne: true } };

CategorySchema.index({ fullSlug: 1 }, { unique: true, partialFilterExpression: NOT_DELETED });
CategorySchema.index({ parentId: 1, sortOrder: 1 }, { partialFilterExpression: NOT_DELETED });
CategorySchema.index({ isActive: 1, parentId: 1, sortOrder: 1 }, { partialFilterExpression: NOT_DELETED });
CategorySchema.index({ createdAt: -1 }, { partialFilterExpression: NOT_DELETED });

baseToJSON(CategorySchema);

export const Category = getOrCreateModel("Category", CategorySchema);
export default Category;
