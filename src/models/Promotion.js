import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const PromotionSchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120, required: true },
    description: { type: String, trim: true, maxlength: 500, default: "" },

    type: { type: String, enum: ["PERCENT", "FIXED", "FREE_SHIPPING"], required: true },
    value: { type: Number, required: true, min: 0 },

    code: { type: String, trim: true, uppercase: true, maxlength: 60, default: null },
    autoApply: { type: Boolean, default: false, index: true },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },

    priority: { type: Number, default: 0 },
    stackingPolicy: {
      type: String,
      enum: ["EXCLUSIVE", "STACKABLE", "STACKABLE_SAME_PRIORITY_ONLY"],
      default: "EXCLUSIVE",
    },

    eligibility: {
      minSubtotalMinor: { type: Number, default: 0, min: 0 },
      maxDiscountMinor: { type: Number, default: null, min: 0 },
      cities: { type: [String], default: [] },
    },

    scope: {
      storewide: { type: Boolean, default: true },
      include: {
        products: { type: [Types.ObjectId], ref: "Product", default: [] },
        categories: { type: [Types.ObjectId], ref: "Category", default: [] },
        brands: { type: [String], default: [] },
      },
      exclude: {
        products: { type: [Types.ObjectId], ref: "Product", default: [] },
        categories: { type: [Types.ObjectId], ref: "Category", default: [] },
        brands: { type: [String], default: [] },
      },
    },

    targeting: {
      mode: { type: String, enum: ["ALL", "WHITELIST", "SEGMENTS", "ROLES"], default: "ALL" },
      allowedUserIds: { type: [Types.ObjectId], ref: "User", default: [] },
      allowedSegments: { type: [String], default: [] },
      allowedRoles: { type: [String], default: [] },
    },

    limits: {
      maxUsesTotal: { type: Number, default: null, min: 0 },
      maxUsesPerUser: { type: Number, default: null, min: 0 },
      usesTotal: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, strict: true },
);

PromotionSchema.index({ code: 1 }, { unique: true, sparse: true });
PromotionSchema.index({ isActive: 1, autoApply: 1, startsAt: 1, endsAt: 1, priority: -1 });

baseToJSON(PromotionSchema);

export const Promotion = getOrCreateModel("Promotion", PromotionSchema);
export default Promotion;
