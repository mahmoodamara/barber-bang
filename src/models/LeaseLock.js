import mongoose from "mongoose";
const { Schema } = mongoose;

const LeaseLockSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
  },
  { timestamps: true },
);

LeaseLockSchema.index({ lockedUntil: 1 });

export const LeaseLock = mongoose.models.LeaseLock || mongoose.model("LeaseLock", LeaseLockSchema);
