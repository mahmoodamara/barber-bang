import mongoose from "mongoose";
import { PERMISSIONS } from "../config/permissions.js";

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
          { _id: false },
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
  { _id: false },
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
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },

    isEmailVerified: { type: Boolean, default: false },

    // Keep enum additive (support staff later if your auth middleware already uses it)
    role: { type: String, enum: ["user", "admin", "staff"], default: "user" },

    // Staff permissions (only used when role = "staff")
    // Admin has all permissions by default; staff has only explicitly granted ones
    permissions: {
      type: [String],
      enum: Object.values(PERMISSIONS),
      default: [],
    },

    // Token version for revocation (logout/change password invalidates old tokens)
    tokenVersion: { type: Number, default: 0, min: 0 },

    cart: { type: [cartItemSchema], default: [] },

    // ✅ WISHLIST (Protected)
    // List of Product ObjectIds (no duplicates enforced at DB level; handled in route logic)
    wishlist: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Product",
      default: [],
    },

    // B2B / Wholesale
    accountType: {
      type: String,
      enum: ["individual", "business"],
      default: "individual",
    },
    businessName: { type: String, default: "", trim: true, maxlength: 200 },
    businessId: { type: String, default: "", trim: true, maxlength: 50 },
    taxId: { type: String, default: "", trim: true, maxlength: 50 },
    wholesaleTier: {
      type: String,
      enum: ["none", "bronze", "silver", "gold"],
      default: "none",
    },
    b2bApproved: { type: Boolean, default: false },
    b2bAppliedAt: { type: Date, default: null },
    b2bApprovedAt: { type: Date, default: null },
    b2bRejectedAt: { type: Date, default: null },

    // Credit terms (Net 30)
    creditLimit: { type: Number, default: 0, min: 0 },
    creditTermDays: { type: Number, default: 0, min: 0 },
    creditBalance: { type: Number, default: 0, min: 0 },

    // Per-customer custom pricing (overrides tier pricing)
    customPricing: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        price: { type: Number, min: 0 },
        _id: false,
      },
    ],

    // Volume-based tier progression tracking
    totalB2BSpent: { type: Number, default: 0, min: 0 },
    tierLockedByAdmin: { type: Boolean, default: false },

    // ✅ Admin-controlled blocking
    isBlocked: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },
    blockedReason: { type: String, default: "", maxlength: 400 },

    // ✅ Account lockout after failed login attempts
    loginAttempts: { type: Number, default: 0, min: 0 },
    lockoutUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

// Compound index for blocked user queries
userSchema.index({ isBlocked: 1, createdAt: -1 });

// Index for B2B admin queries
userSchema.index({ b2bAppliedAt: -1 });
userSchema.index({ b2bApproved: 1, b2bAppliedAt: -1 });

export const User = mongoose.model("User", userSchema);
