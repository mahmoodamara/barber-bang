import mongoose from "mongoose";

const { Schema } = mongoose;

const AlertLogSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    lastSentAt: { type: Date, required: true },
    meta: { type: Schema.Types.Mixed, default: {} },

    // TTL field (expire at exact time)
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

AlertLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AlertLog = mongoose.models.AlertLog || mongoose.model("AlertLog", AlertLogSchema);
