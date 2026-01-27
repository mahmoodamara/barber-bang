// src/models/StockReservation.js
import mongoose from "mongoose";

const reservationItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1, max: 999 },
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
      index: true,
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stockReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StockReservation = mongoose.model("StockReservation", stockReservationSchema);
