import mongoose from "mongoose";

// Reuse same structure as User.cart items
const guestCartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: { type: Number, required: true, min: 1, max: 999 },
    variantId: { type: String, default: "" },
    variantSnapshot: {
      type: {
        variantId: { type: String, default: "" },
        sku: { type: String, default: "" },
        price: { type: Number, default: 0 },
        priceMinor: { type: Number, default: 0 },
        attributesList: { type: [mongoose.Schema.Types.Mixed], default: [] },
        attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
      },
      default: null,
    },
  },
  { _id: false }
);

const guestCartSchema = new mongoose.Schema(
  {
    cartId: { type: String, required: true, unique: true },
    items: { type: [guestCartItemSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// TTL index: expire guest carts after 30 days of inactivity
guestCartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
guestCartSchema.index({ cartId: 1 });

export const GuestCart = mongoose.model("GuestCart", guestCartSchema);
