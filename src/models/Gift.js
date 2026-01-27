import mongoose from "mongoose";

const giftSchema = new mongoose.Schema(
  {
    // Bilingual
    nameHe: { type: String, required: true, trim: true, maxlength: 160 },
    nameAr: { type: String, default: "", trim: true, maxlength: 160 },

    // Legacy
    name: { type: String, default: "", trim: true },
    giftProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },

    // rules (any of them can be set)
    minOrderTotal: { type: Number, default: null, min: 0 },
    requiredProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    requiredCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Fast lookups for active gifts and matching rules
giftSchema.index({ isActive: 1, startAt: 1, endAt: 1, createdAt: -1 });
giftSchema.index({ minOrderTotal: 1 });

export const Gift = mongoose.model("Gift", giftSchema);
