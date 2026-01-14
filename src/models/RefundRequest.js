import mongoose from "mongoose";

const { Schema } = mongoose;

const RefundRequestSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true }, // Idempotency-Key
    actorId: { type: Schema.Types.ObjectId, default: null },

    amount: { type: Number, required: true }, // minor units
    currency: { type: String, required: true, default: "ILS" },

    reason: { type: String, default: "" },
    restock: { type: Boolean, default: false },

    status: { type: String, enum: ["created", "succeeded", "failed"], default: "created" },
    stripeRefundId: { type: String, default: null },
    error: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

RefundRequestSchema.index({ orderId: 1, key: 1 }, { unique: true });

export const RefundRequest =
  mongoose.models.RefundRequest || mongoose.model("RefundRequest", RefundRequestSchema);
