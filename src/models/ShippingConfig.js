// src/models/ShippingConfig.js
// Singleton document that stores configurable shipping rules.
// Admin can update thresholds and base prices without touching code.

import mongoose from "mongoose";

const shippingConfigSchema = new mongoose.Schema(
  {
    /**
     * Order total threshold (in currency units) above which shipping is free.
     * retail:    B2C customers (e.g. ≥ 400)
     * wholesale: B2B customers (e.g. ≥ 1000)
     */
    freeShippingThreshold: {
      retail:    { type: Number, required: true, min: 0, default: 400 },
      wholesale: { type: Number, required: true, min: 0, default: 1000 },
    },

    /**
     * Flat shipping fee charged when the order total is below the free threshold.
     * retail:    B2C customers
     * wholesale: B2B customers
     */
    baseShippingPrice: {
      retail:    { type: Number, required: true, min: 0, default: 30 },
      wholesale: { type: Number, required: true, min: 0, default: 50 },
    },
  },
  {
    timestamps: true, // adds createdAt + updatedAt automatically
  }
);

export const ShippingConfig = mongoose.model("ShippingConfig", shippingConfigSchema);
