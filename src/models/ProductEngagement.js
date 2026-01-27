// src/models/ProductEngagement.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const productEngagementSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    day: { type: Date, required: true, index: true },
    type: {
      type: String,
      enum: ["view", "add_to_cart", "wishlist"],
      required: true,
      index: true,
    },
    // user-based or hashed ip+ua
    actorKey: { type: String, required: true, maxlength: 120 },
  },
  { timestamps: true }
);

productEngagementSchema.index(
  { productId: 1, day: 1, type: 1, actorKey: 1 },
  { unique: true }
);

// TTL to keep table small (45 days)
productEngagementSchema.index({ createdAt: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

export const ProductEngagement = mongoose.model(
  "ProductEngagement",
  productEngagementSchema
);
