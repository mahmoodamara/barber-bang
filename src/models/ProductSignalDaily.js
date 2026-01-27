// src/models/ProductSignalDaily.js
import mongoose from "mongoose";

const { Schema } = mongoose;

const productSignalDailySchema = new Schema(
  {
    // Note: single-field indexes removed - compound index { productId: 1, day: 1 } covers productId prefix
    // and explicit { day: -1, productId: 1 } index exists for day-first queries
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },

    // UTC day bucket (00:00:00)
    day: { type: Date, required: true },

    // Engagement
    views: { type: Number, default: 0 },
    addToCart: { type: Number, default: 0 },
    wishlisted: { type: Number, default: 0 },

    // Sales (minor units + qty)
    unitsSold: { type: Number, default: 0 },
    revenueMinor: { type: Number, default: 0 },

    // Refunds (minor units + qty)
    unitsRefunded: { type: Number, default: 0 },
    revenueRefundedMinor: { type: Number, default: 0 },

    // Reviews (approved only)
    reviewCount: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One doc per product per day
productSignalDailySchema.index({ productId: 1, day: 1 }, { unique: true });

/**
 * ============================================================================
 * Ranking/Analytics indexes
 * ============================================================================
 */

// Day-based aggregation for time-windowed queries
productSignalDailySchema.index({ day: -1, productId: 1 });

// Units sold aggregation
productSignalDailySchema.index({ day: 1, unitsSold: -1 });

// Views aggregation
productSignalDailySchema.index({ day: 1, views: -1 });

export const ProductSignalDaily = mongoose.model(
  "ProductSignalDaily",
  productSignalDailySchema
);
