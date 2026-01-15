// src/models/PickupPoint.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

function intMin0(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * PickupPoint - Admin-defined pickup locations linked to DeliveryAreas
 * 
 * Rules:
 * - Must belong to a DeliveryArea
 * - feeMinor defaults to 0 (most pickup points are free)
 * - hours: operating hours for display
 */
const PickupPointSchema = new Schema(
  {
    // Reference to parent area
    areaId: { type: Types.ObjectId, ref: "DeliveryArea", required: true, index: true },

    // Display name (localized)
    nameHe: { type: String, trim: true, maxlength: 120, required: true },
    nameAr: { type: String, trim: true, maxlength: 120, required: true },

    // Address (localized)
    addressHe: { type: String, trim: true, maxlength: 300, required: true },
    addressAr: { type: String, trim: true, maxlength: 300, required: true },

    // Additional notes/instructions (localized)
    notesHe: { type: String, trim: true, maxlength: 500, default: "" },
    notesAr: { type: String, trim: true, maxlength: 500, default: "" },

    // Operating hours (localized)
    hoursHe: { type: String, trim: true, maxlength: 200, default: "" },
    hoursAr: { type: String, trim: true, maxlength: 200, default: "" },

    // Fee for using this pickup point (minor units, default 0)
    feeMinor: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "feeMinor must be integer >= 0" },
    },

    // Contact phone (optional)
    phone: { type: String, trim: true, maxlength: 30, default: "" },

    // GPS coordinates (optional, for maps)
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },

    // Sort order for display within area
    sort: { type: Number, default: 100, index: true },

    // Whether this pickup point is active
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, strict: true },
);

PickupPointSchema.index({ areaId: 1, isActive: 1, sort: 1 });
PickupPointSchema.index({ isActive: 1, sort: 1 });

baseToJSON(PickupPointSchema);

export const PickupPoint = getOrCreateModel("PickupPoint", PickupPointSchema);
export default PickupPoint;
