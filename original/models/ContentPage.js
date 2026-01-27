// src/models/ContentPage.js
import mongoose from "mongoose";

const contentPageSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
    },

    // Bilingual fields
    titleHe: { type: String, required: true, trim: true, maxlength: 160 },
    titleAr: { type: String, default: "", trim: true, maxlength: 160 },

    contentHe: { type: String, required: true, trim: true, maxlength: 20000 },
    contentAr: { type: String, default: "", trim: true, maxlength: 20000 },

    // Optional toggles
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true },
);

contentPageSchema.index({ slug: 1 }, { unique: true });
contentPageSchema.index({ isActive: 1, sortOrder: 1 });

export const ContentPage = mongoose.model("ContentPage", contentPageSchema);
