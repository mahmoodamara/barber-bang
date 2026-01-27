// src/models/Offer.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const offerSchema = new Schema(
  {
    // Bilingual names (default: Hebrew)
    nameHe: { type: String, required: true, trim: true, minlength: 2, maxlength: 160 },
    nameAr: { type: String, default: "", trim: true, maxlength: 160 },

    // legacy (optional)
    name: { type: String, default: "", trim: true, maxlength: 160 },

    type: {
      type: String,
      required: true,
      enum: ["PERCENT_OFF", "FIXED_OFF", "FREE_SHIPPING", "BUY_X_GET_Y"],
    },

    // PERCENT_OFF: value = percent
    // FIXED_OFF: value = amount (ILS major)
    value: { type: Number, default: 0, min: 0 },

    // Applies when subtotal >= minTotal
    minTotal: { type: Number, default: 0, min: 0 },

    // ✅ FIXED: proper array of refs
    productIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Product" }],
      default: [],
    },
    categoryIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Category" }],
      default: [],
    },

    // BUY_X_GET_Y fields
    buyProductId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    buyVariantId: { type: String, default: null }, // optional variant constraint
    buyQty: { type: Number, default: 1, min: 1, max: 999 },

    getProductId: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    getVariantId: { type: String, default: null }, // optional: specific variant as gift
    getQty: { type: Number, default: 1, min: 1, max: 50 },

    // Guardrails
    maxDiscount: { type: Number, default: null, min: 0 }, // null = unlimited
    stackable: { type: Boolean, default: true },
    priority: { type: Number, default: 100, min: 0 }, // lower = earlier

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * ✅ Strong validations to prevent bad offers entering DB
 */
offerSchema.pre("validate", function offerPreValidate(next) {
  // Keep legacy name synced (Hebrew primary)
  if (!this.name) this.name = this.nameHe || "";

  // Percent-off must be <= 100
  if (this.type === "PERCENT_OFF") {
    if (this.value > 100) this.value = 100;
  }

  // BUY_X_GET_Y must include both product ids
  if (this.type === "BUY_X_GET_Y") {
    if (!this.buyProductId || !this.getProductId) {
      return next(new Error("BUY_X_GET_Y requires buyProductId and getProductId"));
    }
  }

  // FREE_SHIPPING ignores value/maxDiscount
  if (this.type === "FREE_SHIPPING") {
    this.value = 0;
    this.maxDiscount = null;
  }

  return next();
});

/**
 * ✅ Useful indexes for seasonal offers
 */
offerSchema.index({ type: 1, createdAt: -1 });
offerSchema.index({ isActive: 1, priority: 1, createdAt: -1 });
offerSchema.index({ startAt: 1, endAt: 1 });

export const Offer = mongoose.model("Offer", offerSchema);
