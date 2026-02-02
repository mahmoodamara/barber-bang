// src/models/CouponRedemption.js
/**
 * ✅ DELIVERABLE #2: Coupon Redemption Collection
 *
 * Replaces Coupon.usedByOrders array to avoid 16MB document limit.
 * Provides idempotent coupon consumption with unique index.
 */
import mongoose from "mongoose";

const couponRedemptionSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    couponCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    // Amount discounted in major currency (ILS)
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    redeemedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// ✅ Unique compound index: one redemption per coupon+order (idempotency)
couponRedemptionSchema.index({ couponId: 1, orderId: 1 }, { unique: true });

// ✅ Index for counting redemptions per coupon
couponRedemptionSchema.index({ couponId: 1, redeemedAt: 1 });

// ✅ Index for looking up by coupon code
couponRedemptionSchema.index({ couponCode: 1, redeemedAt: 1 });

// ✅ Index for per-user usage limits
couponRedemptionSchema.index({ couponId: 1, userId: 1 });

export const CouponRedemption = mongoose.model("CouponRedemption", couponRedemptionSchema);
