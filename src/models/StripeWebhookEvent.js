// src/models/StripeWebhookEvent.js
/**
 * Stripe webhook event processing log (idempotency + operational visibility).
 */
import mongoose from "mongoose";

const stripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },
    type: {
      type: String,
      trim: true,
      maxlength: 128,
      default: "",
    },
    sessionId: {
      type: String,
      trim: true,
      maxlength: 256,
      default: "",
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["received", "processing", "processed", "failed"],
      default: "received",
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 256,
    },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    failureStep: { type: String, default: "" },
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true }
);

stripeWebhookEventSchema.index({ eventId: 1 }, { unique: true });
stripeWebhookEventSchema.index({ status: 1, createdAt: -1 });
stripeWebhookEventSchema.index({ sessionId: 1 }, { sparse: true });
stripeWebhookEventSchema.index({ orderId: 1, createdAt: -1 });

export const StripeWebhookEvent = mongoose.model(
  "StripeWebhookEvent",
  stripeWebhookEventSchema
);
