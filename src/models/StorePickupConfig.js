// src/models/StorePickupConfig.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

/**
 * StorePickupConfig - Singleton configuration for main store pickup
 * 
 * Rules:
 * - Only one document should exist (enforced by unique configKey)
 * - fee is ALWAYS 0 (enforced in pre-validate)
 * - Used for STORE_PICKUP shipping mode
 */
const StorePickupConfigSchema = new Schema(
  {
    // Unique key to ensure singleton (always "main")
    configKey: { type: String, default: "main", immutable: true },

    // Display name (localized)
    nameHe: { type: String, trim: true, maxlength: 120, default: "החנות הראשית" },
    nameAr: { type: String, trim: true, maxlength: 120, default: "المتجر الرئيسي" },

    // Store address (localized)
    addressHe: { type: String, trim: true, maxlength: 300, default: "" },
    addressAr: { type: String, trim: true, maxlength: 300, default: "" },

    // Operating hours (localized)
    hoursHe: { type: String, trim: true, maxlength: 200, default: "" },
    hoursAr: { type: String, trim: true, maxlength: 200, default: "" },

    // Additional notes/instructions (localized)
    notesHe: { type: String, trim: true, maxlength: 500, default: "" },
    notesAr: { type: String, trim: true, maxlength: 500, default: "" },

    // Contact phone
    phone: { type: String, trim: true, maxlength: 30, default: "" },

    // GPS coordinates (for maps)
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },

    // Whether store pickup is available
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true },
);

// Ensure fee is always 0 (store pickup is free)
StorePickupConfigSchema.virtual("feeMinor").get(function () {
  return 0;
});

StorePickupConfigSchema.index({ configKey: 1 }, { unique: true });

baseToJSON(StorePickupConfigSchema);

export const StorePickupConfig = getOrCreateModel("StorePickupConfig", StorePickupConfigSchema);
export default StorePickupConfig;
