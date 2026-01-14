import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const PromotionRedemptionSchema = new Schema(
  {
    promotionId: { type: Types.ObjectId, ref: "Promotion", required: true, index: true },
    orderId: { type: Types.ObjectId, ref: "Order", required: true },
    userId: { type: Types.ObjectId, ref: "User", default: null, index: true },

    status: {
      type: String,
      enum: ["reserved", "confirmed", "released"],
      default: "reserved",
      index: true,
    },
  },
  { timestamps: true, strict: true },
);

PromotionRedemptionSchema.index({ promotionId: 1, orderId: 1 }, { unique: true });
PromotionRedemptionSchema.index({ promotionId: 1, userId: 1, status: 1 });
PromotionRedemptionSchema.index({ orderId: 1, status: 1 });

baseToJSON(PromotionRedemptionSchema);

export const PromotionRedemption = getOrCreateModel("PromotionRedemption", PromotionRedemptionSchema);
export default PromotionRedemption;
