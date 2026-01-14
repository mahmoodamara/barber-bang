import mongoose from "mongoose";
const { Schema } = mongoose;

const RateLimitBucketSchema = new Schema(
  {
    key: { type: String, required: true },
    windowStartMs: { type: Number, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

RateLimitBucketSchema.index({ key: 1, windowStartMs: 1 }, { unique: true });
RateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitBucket =
  mongoose.models.RateLimitBucket || mongoose.model("RateLimitBucket", RateLimitBucketSchema);
