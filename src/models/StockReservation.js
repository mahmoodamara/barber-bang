import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

function intMin1(v) {
  return Number.isInteger(v) && v >= 1;
}

const StockReservationSchema = new Schema(
  {
    orderId: { type: Types.ObjectId, ref: "Order", required: true, index: true },
    variantId: { type: Types.ObjectId, ref: "Variant", required: true, index: true },
    productId: { type: Types.ObjectId, ref: "Product", default: null, index: true },

    quantity: {
      type: Number,
      required: true,
      validate: { validator: intMin1, message: "quantity must be integer >= 1" },
    },

    status: {
      type: String,
      enum: ["reserved", "confirmed", "released"],
      default: "reserved",
      index: true,
    },
    reservedAt: { type: Date, default: Date.now },
    confirmedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    // Optional: reservation expiry for cleanup/reconciliation
    expiresAt: { type: Date, default: null, index: true },
    reason: { type: String, trim: true, maxlength: 200, default: "" },
  },
  { timestamps: true, strict: true },
);

// Idempotent per-order/variant ownership
StockReservationSchema.index({ orderId: 1, variantId: 1 }, { unique: true });
StockReservationSchema.index({ status: 1, expiresAt: 1 });

baseToJSON(StockReservationSchema);

export const StockReservation = getOrCreateModel("StockReservation", StockReservationSchema);
export default StockReservation;
