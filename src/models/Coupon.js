import mongoose from "mongoose";

/**
 * ✅ DELIVERABLE #2: Updated Coupon Schema
 *
 * Changes:
 * - Use CouponReservation and CouponRedemption collections instead
 * - Counters (usedCount, reservedCount) maintained atomically
 * - Added usagePerUser for per-user limits
 */
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },

    minOrderTotal: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: null, min: 0 },

    // Usage limits
    usageLimit: { type: Number, default: null, min: 1 },
    usagePerUser: { type: Number, default: null, min: 1 }, // ✅ NEW: Per-user limit

    // ✅ Counters - maintained by CouponReservation/CouponRedemption operations
    usedCount: { type: Number, default: 0, min: 0 },
    reservedCount: { type: Number, default: 0, min: 0 },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Index for validation queries
couponSchema.index({ code: 1, isActive: 1, startAt: 1, endAt: 1 });

// ✅ Deprecated indexes - kept for migration period only
// couponSchema.index({ code: 1, usedByOrders: 1 });
// couponSchema.index({ code: 1, reservedByOrders: 1 });

export const Coupon = mongoose.model("Coupon", couponSchema);
