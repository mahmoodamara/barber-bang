import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: { type: Number, required: true, min: 1, max: 999 },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    // Keep enum additive (support staff later if your auth middleware already uses it)
    role: { type: String, enum: ["user", "admin", "staff"], default: "user" },

    // Token version for revocation (logout/change password invalidates old tokens)
    tokenVersion: { type: Number, default: 0, min: 0 },

    cart: { type: [cartItemSchema], default: [] },

    // ✅ WISHLIST (Protected)
    // List of Product ObjectIds (no duplicates enforced at DB level; handled in route logic)
    wishlist: { type: [mongoose.Schema.Types.ObjectId], ref: "Product", default: [] },
  },
  { timestamps: true },
);

// Helpful index for common access patterns
userSchema.index({ email: 1 });

export const User = mongoose.model("User", userSchema);
