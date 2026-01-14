import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const StockLogSchema = new Schema(
  {
    variantId: { type: Types.ObjectId, ref: "Variant", required: true, index: true },

    type: {
      type: String,
      enum: ["reserve", "release_reserve", "confirm_paid", "refund_restore", "manual_adjust"],
      required: true,
      index: true,
    },

    deltaStock: { type: Number, default: 0 },
    deltaReserved: { type: Number, default: 0 },

    orderId: { type: Types.ObjectId, ref: "Order", default: null },
    actorId: { type: Types.ObjectId, ref: "User", default: null },

    reason: { type: String, trim: true, maxlength: 300 },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, strict: true },
);

StockLogSchema.index({ variantId: 1, createdAt: -1 });
StockLogSchema.index({ orderId: 1, createdAt: -1 });

baseToJSON(StockLogSchema);

export const StockLog = getOrCreateModel("StockLog", StockLogSchema);
export default StockLog;
