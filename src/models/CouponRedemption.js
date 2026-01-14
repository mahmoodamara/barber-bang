import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const CouponRedemptionSchema = new Schema(
  {
    couponId: { type: Types.ObjectId, ref: "Coupon", required: true, index: true },
    orderId: { type: Types.ObjectId, ref: "Order", required: true },
    userId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    code: { type: String, trim: true, uppercase: true, maxlength: 60, required: true },

    status: {
      type: String,
      enum: ["reserved", "confirmed", "released"],
      default: "reserved",
      index: true,
    },

    reservedAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    discountTotalMinor: { type: Number, default: null, min: 0 },
    currencySnapshot: { type: String, trim: true, uppercase: true, maxlength: 10, default: null },
  },
  { timestamps: true, strict: true },
);

CouponRedemptionSchema.index({ couponId: 1, orderId: 1 }, { unique: true });
CouponRedemptionSchema.index({ couponId: 1, userId: 1, status: 1 });
CouponRedemptionSchema.index({ code: 1, status: 1 });
CouponRedemptionSchema.index({ orderId: 1, createdAt: -1 });
CouponRedemptionSchema.index({ createdAt: -1 });

baseToJSON(CouponRedemptionSchema);

export const CouponRedemption = getOrCreateModel("CouponRedemption", CouponRedemptionSchema);
export default CouponRedemption;
