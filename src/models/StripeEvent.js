import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

const StripeEventSchema = new Schema(
  {
    eventId: { type: String, trim: true, maxlength: 200, required: true },
    type: { type: String, trim: true, maxlength: 120 },
    created: { type: Number }, // stripe event created (unix)
    processedAt: { type: Date, default: null },
    status: { type: String, enum: ["received", "processed", "failed"], default: "received", index: true },
    lastError: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true, strict: true },
);

StripeEventSchema.index({ eventId: 1 }, { unique: true });
StripeEventSchema.index({ status: 1, createdAt: -1 });
StripeEventSchema.index({ processedAt: 1 });

// (اختياري) سياسة احتفاظ للأحداث — فعّلها حسب قرارك
// StripeEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

baseToJSON(StripeEventSchema);

export const StripeEvent = getOrCreateModel("StripeEvent", StripeEventSchema);
export default StripeEvent;
