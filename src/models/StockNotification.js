import mongoose from "mongoose";

const stockNotificationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Invalid email"],
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    variantId: { type: String, default: "" },
    notified: { type: Boolean, default: false },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

stockNotificationSchema.index(
  { productId: 1, email: 1, variantId: 1 },
  { unique: true },
);
stockNotificationSchema.index({ productId: 1, notified: 1 });

export const StockNotification = mongoose.model(
  "StockNotification",
  stockNotificationSchema,
);
