import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const PromotionUserUsageSchema = new Schema(
  {
    promotionId: { type: Types.ObjectId, ref: "Promotion", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    usesTotal: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, strict: true },
);

PromotionUserUsageSchema.index({ promotionId: 1, userId: 1 }, { unique: true });

baseToJSON(PromotionUserUsageSchema);

export const PromotionUserUsage = getOrCreateModel("PromotionUserUsage", PromotionUserUsageSchema);
export default PromotionUserUsage;
