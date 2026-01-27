// src/models/Review.js
import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ✅ Additive snapshot (optional, helps UI without populate)
    userName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 80,
    },

    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: "rating must be an integer between 1 and 5",
      },
    },

    comment: {
      type: String,
      default: "",
      trim: true,
      maxlength: 600,
    },

    // ✅ Soft moderation / hide reviews without deleting
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

// ✅ Prevent multiple reviews per user per product
reviewSchema.index({ productId: 1, userId: 1 }, { unique: true });

// ✅ Useful listing index
reviewSchema.index({ productId: 1, isActive: 1, createdAt: -1 });

export const Review = mongoose.model("Review", reviewSchema);
