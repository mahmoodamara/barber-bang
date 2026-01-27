import mongoose from "mongoose";

const cartVariantSnapshotSchema = new mongoose.Schema(
  {
    variantId: { type: String, default: "" },
    sku: { type: String, default: "" },
    price: { type: Number, default: 0, min: 0 }, // ILS major
    priceMinor: { type: Number, default: 0, min: 0 },
    attributesList: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, default: "" },
            type: { type: String, default: "" },
            value: { type: mongoose.Schema.Types.Mixed, default: null },
            valueKey: { type: String, default: "" },
            unit: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    attributes: {
      volumeMl: { type: Number, default: null, min: 0 },
      weightG: { type: Number, default: null, min: 0 },
      packCount: { type: Number, default: null, min: 0 },
      scent: { type: String, default: "" },
      holdLevel: { type: String, default: "" },
      finishType: { type: String, default: "" },
      skinType: { type: String, default: "" },
    },
  },
  { _id: false }
);

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: { type: Number, required: true, min: 1, max: 999 },

    // Optional variant selection
    variantId: { type: String, default: "" },
    variantSnapshot: { type: cartVariantSnapshotSchema, default: null },
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

    // Staff permissions (only used when role = "staff")
    // Admin has all permissions by default; staff has only explicitly granted ones
    permissions: {
      type: [String],
      enum: ["ORDERS_WRITE", "PRODUCTS_WRITE", "PROMOS_WRITE", "SETTINGS_WRITE"],
      default: [],
    },

    // Token version for revocation (logout/change password invalidates old tokens)
    tokenVersion: { type: Number, default: 0, min: 0 },

    cart: { type: [cartItemSchema], default: [] },

    // ✅ WISHLIST (Protected)
    // List of Product ObjectIds (no duplicates enforced at DB level; handled in route logic)
    wishlist: { type: [mongoose.Schema.Types.ObjectId], ref: "Product", default: [] },

    // ✅ Admin-controlled blocking
    isBlocked: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },
    blockedReason: { type: String, default: "", maxlength: 400 },
  },
  { timestamps: true },
);

// Compound index for blocked user queries
userSchema.index({ isBlocked: 1, createdAt: -1 });

export const User = mongoose.model("User", userSchema);
