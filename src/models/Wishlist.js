// src/models/Wishlist.js
import mongoose from "mongoose";
const { Schema, Types } = mongoose;

const WishlistItemSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 120, index: true },
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    variantId: { type: Types.ObjectId, ref: "Variant", default: null, index: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const WishlistSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true },
    itemsKeys: { type: [String], default: [] }, // dedupe set
    items: { type: [WishlistItemSchema], default: [] },
  },
  { timestamps: true, strict: true },
);

WishlistSchema.index({ updatedAt: -1 });
WishlistSchema.index({ "items.productId": 1, updatedAt: -1 });

export const Wishlist = mongoose.models.Wishlist || mongoose.model("Wishlist", WishlistSchema);
