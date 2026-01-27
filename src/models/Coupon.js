import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },

    minOrderTotal: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: null, min: 0 },

    usageLimit: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    reservedCount: { type: Number, default: 0, min: 0 },

    // Track which orders used this coupon (for idempotent atomic consumption)
    usedByOrders: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
      default: [],
    },

    // Track which orders reserved this coupon (short-lived)
    reservedByOrders: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order" }],
      default: [],
    },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Index for atomic consumption checks (code is already unique via schema)
couponSchema.index({ code: 1, usedByOrders: 1 });
couponSchema.index({ code: 1, reservedByOrders: 1 });

export const Coupon = mongoose.model("Coupon", couponSchema);
