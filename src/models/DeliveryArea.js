// src/models/DeliveryArea.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

function intMin0(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * DeliveryArea - Admin-defined delivery zones
 * 
 * Rules:
 * - deliveryEnabled: whether DELIVERY mode is available in this area
 * - deliveryPriceMinor: shipping price for DELIVERY mode (minor units)
 * - pickupPointsEnabled: whether PICKUP_POINT mode is available in this area
 */
const DeliveryAreaSchema = new Schema(
  {
    // Display name (localized)
    nameHe: { type: String, trim: true, maxlength: 120, required: true },
    nameAr: { type: String, trim: true, maxlength: 120, required: true },

    // Unique code for API references
    code: { type: String, trim: true, uppercase: true, maxlength: 50, required: true },

    // Whether delivery to address is available in this area
    deliveryEnabled: { type: Boolean, default: true },

    // Delivery price in minor units (e.g., 1500 = 15.00 ILS)
    deliveryPriceMinor: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "deliveryPriceMinor must be integer >= 0" },
    },

    // Whether pickup points are available in this area
    pickupPointsEnabled: { type: Boolean, default: true },

    // Optional: minimum subtotal for free delivery (minor units)
    freeDeliveryAboveMinor: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || intMin0(v), message: "freeDeliveryAboveMinor invalid" },
    },

    // Optional: minimum subtotal required for delivery (minor units)
    minSubtotalMinor: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || intMin0(v), message: "minSubtotalMinor invalid" },
    },

    // Sort order for display
    sort: { type: Number, default: 100, index: true },

    // Whether this area is active
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, strict: true },
);

DeliveryAreaSchema.index({ code: 1 }, { unique: true });
DeliveryAreaSchema.index({ isActive: 1, sort: 1 });
DeliveryAreaSchema.index({ isActive: 1, deliveryEnabled: 1 });
DeliveryAreaSchema.index({ isActive: 1, pickupPointsEnabled: 1 });

baseToJSON(DeliveryAreaSchema);

export const DeliveryArea = getOrCreateModel("DeliveryArea", DeliveryAreaSchema);
export default DeliveryArea;
