// src/models/CouponReservation.js
/**
 * ✅ DELIVERABLE #2: Coupon Reservation Collection
 *
 * Replaces Coupon.reservedByOrders array to avoid 16MB document limit.
 * TTL indexed for automatic cleanup of expired reservations.
 */
import mongoose from "mongoose";

const couponReservationSchema = new mongoose.Schema(
  {
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      required: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
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
    expiresAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "consumed", "released", "expired"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

// ✅ Unique compound index: one reservation per coupon+order
couponReservationSchema.index({ couponId: 1, orderId: 1 }, { unique: true });

// ✅ Unique partial index: one ACTIVE reservation per coupon+user (for usagePerUser enforcement)
// This prevents race conditions when multiple requests from the same user try to reserve
// Note: Using $type: "objectId" instead of $ne: null for compatibility with older MongoDB versions
couponReservationSchema.index(
  { couponId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active", userId: { $type: "objectId" } },
  }
);

// ✅ Index for finding active reservations per coupon
couponReservationSchema.index({ couponId: 1, status: 1, expiresAt: 1 });

// ✅ Index for looking up by coupon code (normalized queries)
couponReservationSchema.index({ couponCode: 1, orderId: 1 });

// ✅ TTL index: MongoDB auto-deletes documents 0 seconds after expiresAt
// Note: Only removes if status is not 'consumed' (handled in application logic)
couponReservationSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { status: { $in: ["expired", "released", "consumed"] } },
  }
);

export const CouponReservation = mongoose.model("CouponReservation", couponReservationSchema);
