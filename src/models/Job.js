import mongoose from "mongoose";

const { Schema } = mongoose;

const JobSchema = new Schema(
  {
    name: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ["pending", "processing", "succeeded", "failed"],
      default: "pending",
      index: true,
    },

    runAt: { type: Date, default: () => new Date(), index: true },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 8 },

    // lease lock
    lockId: { type: String, default: null },
    lockedUntil: { type: Date, default: null, index: true },

    lastError: { type: String, default: null },
    finishedAt: { type: Date, default: null },

    // dedupe
    dedupeKey: { type: String, default: null },
  },
  { timestamps: true },
);

// Claim performance
JobSchema.index({ status: 1, runAt: 1, lockedUntil: 1 });

// Admin lists / ops queries
JobSchema.index({ status: 1, createdAt: -1 });
JobSchema.index({ name: 1, createdAt: -1 });
JobSchema.index({ updatedAt: -1 });

// Dedupe (only when dedupeKey is a string)
JobSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

export const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);
