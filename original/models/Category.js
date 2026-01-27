import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    // Bilingual fields (default language: Hebrew)
    nameHe: { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 80 },
    nameAr: { type: String, default: "", trim: true, minlength: 0, maxlength: 80 },

    // Backward compatible legacy field (optional)
    name: { type: String, default: "", trim: true },
    slug: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

// Useful for SEO/URL routing on storefronts
categorySchema.index({ slug: 1 }, { unique: true, sparse: true });

export const Category = mongoose.model("Category", categorySchema);
