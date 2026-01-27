// src/models/ReturnRequest.js
import mongoose from "mongoose";

/**
 * ReturnRequest (Israel-ready MVP)
 * - Separate collection (better than embedding in Order)
 * - Admin review workflow + optional Stripe refund linkage
 */

const returnItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1, max: 999 },

    // snapshots for safety/history
    titleHe: { type: String, default: "" },
    titleAr: { type: String, default: "" },
    title: { type: String, default: "" },

    unitPrice: { type: Number, default: 0, min: 0 }, // ILS major
  },
  { _id: false }
);

const returnRequestSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Contact snapshot (for Israeli operations)
    phone: { type: String, default: "" },
    email: { type: String, default: "" },

    reason: {
      type: String,
      enum: ["wrong_item", "damaged", "not_as_described", "changed_mind", "other"],
      default: "other",
    },

    customerNote: { type: String, default: "" }, // up to you in validation
    adminNote: { type: String, default: "" },

    // Return items
    items: { type: [returnItemSchema], default: [] },

    status: {
      type: String,
      enum: [
        "requested",      // user submitted
        "approved",       // admin approved
        "rejected",       // admin rejected
        "received",       // store received items
        "refund_pending", // refund initiated
        "refunded",       // refunded
        "closed",         // done
      ],
      default: "requested",
    },

    requestedAt: { type: Date, default: () => new Date() },
    decidedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },

    // Stripe refund linkage (only if order.paymentMethod === 'stripe')
    refund: {
      status: {
        type: String,
        enum: ["none", "pending", "succeeded", "failed"],
        default: "none",
      },
      amount: { type: Number, default: 0, min: 0 }, // ILS major
      currency: { type: String, default: "ils" },
      stripeRefundId: { type: String, default: "" },
      failureMessage: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

returnRequestSchema.index({ status: 1, requestedAt: -1 });
returnRequestSchema.index({ userId: 1, requestedAt: -1 });
returnRequestSchema.index({ orderId: 1 });
returnRequestSchema.index({ reason: 1, status: 1 });

export const ReturnRequest = mongoose.model("ReturnRequest", returnRequestSchema);
