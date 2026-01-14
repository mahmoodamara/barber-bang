// src/models/Cart.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

function intMin1(v) {
  return Number.isInteger(v) && v >= 1;
}
function intMax99(v) {
  return Number.isInteger(v) && v <= 99;
}

const CartItemSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 120, index: true }, // `${productId}:${variantId||""}`

    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    variantId: { type: Types.ObjectId, ref: "Variant", default: null, index: true },

    qty: {
      type: Number,
      required: true,
      validate: { validator: (v) => intMin1(v) && intMax99(v), message: "qty must be integer 1..99" },
    },

    addedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false, timestamps: false },
);

const CartSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true },

    // Dedupe set
    itemsKeys: { type: [String], default: [] },
    items: { type: [CartItemSchema], default: [] },
  },
  { timestamps: true, strict: true },
);

CartSchema.index({ updatedAt: -1 });
CartSchema.index({ "items.productId": 1, updatedAt: -1 });

baseToJSON(CartSchema);

export const Cart = getOrCreateModel("Cart", CartSchema);
export default Cart;
