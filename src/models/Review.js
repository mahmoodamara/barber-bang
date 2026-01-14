// src/models/Review.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const REVIEW_STATUSES = Object.freeze(["pending", "approved", "rejected", "deleted"]);

const ReviewSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true },

    rating: { type: Number, required: true, min: 1, max: 5 },

    title: { type: String, trim: true, maxlength: 80, default: "" },
    body: { type: String, trim: true, maxlength: 2000, default: "" },

    // لغة نص المراجعة (مهم لـ UI)
    lang: { type: String, enum: ["he", "ar"], default: "he", index: true },

    status: { type: String, enum: REVIEW_STATUSES, default: "pending", index: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    // Verified purchase enforcement
    verifiedPurchase: { type: Boolean, default: false, index: true },

    isFeatured: { type: Boolean, default: false, index: true },
    verifiedOrderId: { type: Types.ObjectId, ref: "Order", default: null },
    verifiedAt: { type: Date, default: null },

    moderation: {
      moderatedAt: { type: Date, default: null },
      moderatedBy: { type: Types.ObjectId, ref: "User", default: null },
      reason: { type: String, trim: true, maxlength: 300, default: "" },
    },
  },
  { timestamps: true, strict: true },
);

// واحد review لكل (user, product)
// أداء listing للـ public
ReviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
ReviewSchema.index({ productId: 1, status: 1, rating: -1, createdAt: -1 });
ReviewSchema.index({ userId: 1, createdAt: -1 });
ReviewSchema.index({ productId: 1, userId: 1 }, { unique: true });


baseToJSON(ReviewSchema);

export const Review = getOrCreateModel("Review", ReviewSchema);
export default Review;
