import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

const CouponSchema = new Schema(
  {
    code: { type: String, trim: true, uppercase: true, maxlength: 60, required: true },

    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },

    currency: { type: String, trim: true, uppercase: true, default: "ILS", maxlength: 10 },
    minOrderTotal: { type: Number, default: 0, min: 0 },

    maxUsesTotal: { type: Number, default: null, min: 1 },
    usesTotal: { type: Number, default: 0, min: 0 },

    maxUsesPerUser: { type: Number, default: null, min: 0 },
    allowedUserIds: { type: [Schema.Types.ObjectId], ref: "User", default: [], index: true },
    allowedRoles: { type: [String], default: [] },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, strict: true },
);

CouponSchema.index({ code: 1 }, { unique: true });
CouponSchema.index({ code: 1, isActive: 1 });
CouponSchema.index({ isActive: 1, endsAt: 1 });
CouponSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });
CouponSchema.index({ createdAt: -1 });

baseToJSON(CouponSchema);

export const Coupon = getOrCreateModel("Coupon", CouponSchema);
export default Coupon;
