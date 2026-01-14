import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const CouponUserUsageSchema = new Schema(
  {
    couponId: { type: Types.ObjectId, ref: "Coupon", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    usesTotal: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, strict: true },
);

CouponUserUsageSchema.index({ couponId: 1, userId: 1 }, { unique: true });

baseToJSON(CouponUserUsageSchema);

export const CouponUserUsage = getOrCreateModel("CouponUserUsage", CouponUserUsageSchema);
export default CouponUserUsage;
