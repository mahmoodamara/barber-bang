import mongoose from "mongoose";

const sampleItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productTitle: { type: String, default: "" },
  },
  { _id: false },
);

const sampleRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    requestNumber: { type: String, unique: true, sparse: true },

    status: {
      type: String,
      enum: ["submitted", "approved", "shipped", "rejected"],
      default: "submitted",
    },

    items: { type: [sampleItemSchema], required: true, validate: [(v) => v.length > 0 && v.length <= 5, "1-5 sample items allowed"] },
    note: { type: String, maxlength: 1000, default: "" },
    adminNote: { type: String, maxlength: 1000, default: "" },

    shippedAt: { type: Date, default: null },
    trackingNumber: { type: String, default: "" },
  },
  { timestamps: true },
);

sampleRequestSchema.index({ userId: 1, createdAt: -1 });
sampleRequestSchema.index({ status: 1, createdAt: -1 });

sampleRequestSchema.pre("save", async function (next) {
  if (!this.requestNumber) {
    const count = await mongoose.model("SampleRequest").countDocuments();
    this.requestNumber = `SMP-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

export const SampleRequest = mongoose.model("SampleRequest", sampleRequestSchema);
