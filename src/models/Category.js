import mongoose from "mongoose";

import { generateUniqueSlug, slugifyText } from "../utils/slug.js";

const categorySchema = new mongoose.Schema(
  {
    // Bilingual fields (default language: Hebrew)
    nameHe: { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 80 },
    nameAr: { type: String, default: "", trim: true, minlength: 0, maxlength: 80 },

    // Backward compatible legacy field (optional)
    name: { type: String, default: "", trim: true },

    // URL-safe slug for SEO routing.
    // Default undefined (NOT "") so sparse unique index works correctly.
    // Auto-generated in pre-validate hook when missing.
    slug: { type: String, default: undefined, trim: true, lowercase: true },

    imageUrl: { type: String, default: "", trim: true },

    // Visibility + ordering
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },

    // Descriptions (bilingual)
    descriptionHe: { type: String, default: "", trim: true, maxlength: 500 },
    descriptionAr: { type: String, default: "", trim: true, maxlength: 500 },

    // SEO meta (bilingual)
    metaTitleHe: { type: String, default: "", trim: true, maxlength: 70 },
    metaTitleAr: { type: String, default: "", trim: true, maxlength: 70 },
    metaDescriptionHe: { type: String, default: "", trim: true, maxlength: 160 },
    metaDescriptionAr: { type: String, default: "", trim: true, maxlength: 160 },
  },
  { timestamps: true },
);

/**
 * Pre-validate hook: auto-generate slug when missing or empty.
 * Uses nameHe as base input, falls back to name or _id.
 */
categorySchema.pre("validate", async function categoryPreValidate(next) {
  try {
    // Normalize slug: trim + lowercase
    if (typeof this.slug === "string") {
      this.slug = this.slug.trim().toLowerCase();
    }

    // Auto-generate slug if missing or empty
    if (!this.slug) {
      const baseInput = this.nameHe || this.name || this._id?.toString() || Date.now().toString();
      this.slug = await generateUniqueSlug(this.constructor, baseInput, this._id);
    }

    // Re-check uniqueness if slug was modified (not auto-generated above)
    if (this.isModified("slug") && this.slug) {
      const existing = await this.constructor.findOne({
        slug: this.slug,
        _id: { $ne: this._id },
      });
      if (existing) {
        // Collision detected - generate unique suffix
        this.slug = await generateUniqueSlug(this.constructor, this.slug, this._id);
      }
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

// Useful for SEO/URL routing on storefronts
// sparse: true means documents without slug field are not indexed
// Since default is now undefined (not ""), sparse works correctly
categorySchema.index({ slug: 1 }, { unique: true, sparse: true });

// Active categories ordering
categorySchema.index({ isActive: 1, sortOrder: 1 });

export const Category = mongoose.model("Category", categorySchema);
