// src/models/CouponUserUsage.js
// Tracks per-user coupon usage counts for atomic limit enforcement.
import mongoose from "mongoose";

const couponUserUsageSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

couponUserUsageSchema.index({ couponId: 1, userId: 1 }, { unique: true });

export const CouponUserUsage = mongoose.model("CouponUserUsage", couponUserUsageSchema);
