import mongoose from "mongoose";

const templateItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1, max: 9999 },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "Product.variants", default: null },
  },
  { _id: false },
);

const orderTemplateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, maxlength: 200 },
    items: { type: [templateItemSchema], required: true, validate: [(v) => v.length > 0, "At least one item required"] },
  },
  { timestamps: true },
);

orderTemplateSchema.index({ userId: 1, createdAt: -1 });

export const OrderTemplate = mongoose.model("OrderTemplate", orderTemplateSchema);
