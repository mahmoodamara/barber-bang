import mongoose from "mongoose";
const { Schema } = mongoose;

const MAX_PAYLOAD_BYTES = 250_000; // ~250KB (عدّل حسب احتياجك)

const ReadModelSchema = new Schema(
  {
    // canonical identifier (validator enforces format)
    key: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },

    // optional categorization (helps admin filters)
    type: { type: String, index: true, trim: true, maxlength: 60 },

    // the computed document
    payload: { type: Schema.Types.Mixed, default: {} },

    // useful ops metadata
    status: {
      type: String,
      enum: ["ready", "building", "failed"],
      default: "ready",
      index: true,
    },

    generatedAt: { type: Date, required: true, default: () => new Date(), index: true },

    // admin-triggered rebuild coordination
    rebuildRequestedAt: { type: Date, default: null, index: true },

    // optional TTL for ephemeral read models
    expiresAt: { type: Date, default: null },

    // observability fields
    rowCount: { type: Number, default: 0, min: 0 },
    payloadSizeBytes: { type: Number, default: 0, min: 0 },

    lastError: {
      message: { type: String, default: "" },
      code: { type: String, default: "" },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// TTL index (only expires docs that have expiresAt set)
ReadModelSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Frequently-used admin list sort
ReadModelSchema.index({ updatedAt: -1, createdAt: -1 });

// Optional compound index for filtering
ReadModelSchema.index({ type: 1, key: 1 });

// Keep payload bounded + store size metric
ReadModelSchema.pre("save", function preSave(next) {
  try {
    const json = JSON.stringify(this.payload ?? {});
    const bytes = Buffer.byteLength(json, "utf8");
    this.payloadSizeBytes = bytes;

    if (bytes > MAX_PAYLOAD_BYTES) {
      const err = new Error("READ_MODEL_PAYLOAD_TOO_LARGE");
      err.statusCode = 413;
      err.code = "READ_MODEL_PAYLOAD_TOO_LARGE";
      err.details = { maxBytes: MAX_PAYLOAD_BYTES, actualBytes: bytes };
      return next(err);
    }

    return next();
  } catch (e) {
    const err = new Error("READ_MODEL_PAYLOAD_INVALID");
    err.statusCode = 422;
    err.code = "READ_MODEL_PAYLOAD_INVALID";
    return next(err);
  }
});

export const ReadModel = mongoose.models.ReadModel || mongoose.model("ReadModel", ReadModelSchema);
