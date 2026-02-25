import mongoose from "mongoose";

const rfqItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productTitle: { type: String, default: "" },
    qty: { type: Number, required: true, min: 1 },
    note: { type: String, maxlength: 500, default: "" },
  },
  { _id: false },
);

const rfqSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rfqNumber: { type: String, unique: true, sparse: true },

    status: {
      type: String,
      enum: ["submitted", "reviewing", "quoted", "accepted", "rejected", "expired", "converted"],
      default: "submitted",
    },

    items: { type: [rfqItemSchema], required: true, validate: [(v) => v.length > 0, "At least one item required"] },

    customerNote: { type: String, maxlength: 2000, default: "" },
    adminNote: { type: String, maxlength: 2000, default: "" },

    quotedTotal: { type: Number, min: 0, default: null },
    quotedItems: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        qty: { type: Number, min: 1 },
        unitPrice: { type: Number, min: 0 },
        _id: false,
      },
    ],
    quotedAt: { type: Date, default: null },
    quotedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    convertedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },

    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

rfqSchema.index({ userId: 1, createdAt: -1 });
rfqSchema.index({ status: 1, createdAt: -1 });

rfqSchema.pre("save", async function (next) {
  if (!this.rfqNumber) {
    const count = await mongoose.model("RFQ").countDocuments();
    this.rfqNumber = `RFQ-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

export const RFQ = mongoose.model("RFQ", rfqSchema);
