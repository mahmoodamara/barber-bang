import mongoose from "mongoose";
const { Schema } = mongoose;

const IdempotencyRecordSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },

    // ownership/context
    userId: { type: Schema.Types.ObjectId, default: null },
    route: { type: String, required: true },
    method: { type: String, required: true },

    // request fingerprint
    requestHash: { type: String, required: true },

    // processing state
    status: { type: String, enum: ["processing", "done", "failed"], default: "processing" },

    // stored response (bounded)
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord =
  mongoose.models.IdempotencyRecord || mongoose.model("IdempotencyRecord", IdempotencyRecordSchema);
