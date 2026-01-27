// src/models/Campaign.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const campaignSchema = new Schema(
  {
    // Bilingual
    nameHe: { type: String, required: true, trim: true, maxlength: 160 },
    nameAr: { type: String, default: "", trim: true, maxlength: 160 },

    // Legacy
    name: { type: String, default: "", trim: true, maxlength: 160 },

    // percent = percentage off
    // fixed   = fixed ILS amount off (major units)
    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },

    appliesTo: {
      type: String,
      enum: ["all", "products", "categories"],
      default: "all",
      index: true,
    },

    // ✅ FIXED: proper arrays of refs
    productIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Product" }],
      default: [],
    },
    categoryIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Category" }],
      default: [],
    },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

/**
 * ✅ Strong validation so pricing never breaks
 */
campaignSchema.pre("validate", function campaignPreValidate(next) {
  // Keep legacy name synced
  if (!this.name) this.name = this.nameHe || "";

  // Percent guardrails
  if (this.type === "percent") {
    if (this.value > 100) this.value = 100;
  }

  // AppliesTo constraints:
  // - products => must have productIds
  // - categories => must have categoryIds
  if (this.appliesTo === "products") {
    if (!Array.isArray(this.productIds) || this.productIds.length === 0) {
      return next(new Error("Campaign appliesTo=products requires productIds"));
    }
  }

  if (this.appliesTo === "categories") {
    if (!Array.isArray(this.categoryIds) || this.categoryIds.length === 0) {
      return next(new Error("Campaign appliesTo=categories requires categoryIds"));
    }
  }

  // all => clean any accidental targeting arrays (optional but keeps data clean)
  if (this.appliesTo === "all") {
    this.productIds = [];
    this.categoryIds = [];
  }

  return next();
});

/**
 * ✅ Indexes
 */
campaignSchema.index({ isActive: 1, startAt: 1, endAt: 1, createdAt: -1 });

export const Campaign = mongoose.model("Campaign", campaignSchema);
