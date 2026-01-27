// src/models/StockReservation.js
import mongoose from "mongoose";

const reservationItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1, max: 999 },
    variantId: { type: String, default: "" },
    // ✅ Track if this is a gift item (for debugging/auditing)
    isGift: { type: Boolean, default: false },
  },
  { _id: false }
);

const stockReservationSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    items: { type: [reservationItemSchema], required: true },
    status: {
      type: String,
      enum: ["reserved", "confirmed", "released", "expired"],
      default: "reserved",
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL index for automatic cleanup of expired reservations
stockReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Compound index for status queries
stockReservationSchema.index({ status: 1, expiresAt: 1 });

export const StockReservation = mongoose.model("StockReservation", stockReservationSchema);
