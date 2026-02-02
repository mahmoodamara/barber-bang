// src/models/Payment.js
/**
 * Immutable payment/refund ledger for reconciliation.
 * Idempotent inserts: duplicate transactionId/eventId => no-op (unique constraint).
 */
import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },
    eventId: {
      type: String,
      trim: true,
      maxlength: 256,
    },
    type: {
      type: String,
      required: true,
      enum: ["payment", "refund"],
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      maxlength: 8,
      default: "ils",
    },
    status: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
      default: "succeeded",
    },
    provider: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
      default: "stripe",
    },
    rawEventHash: {
      type: String,
      default: "",
      maxlength: 128,
    },
    refundId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },
  },
  { timestamps: true }
);

paymentSchema.index({ transactionId: 1 }, { unique: true });
paymentSchema.index({ eventId: 1 }, { unique: true, sparse: true }); // only non-empty eventIds
paymentSchema.index({ orderId: 1, type: 1, createdAt: -1 });
paymentSchema.index({ refundId: 1 }, { sparse: true });

export const Payment = mongoose.model("Payment", paymentSchema);
