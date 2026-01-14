// src/models/ShippingMethod.js
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

function intMin0(v) {
  return Number.isInteger(v) && v >= 0;
}

const ShippingMethodSchema = new Schema(
  {
    code: { type: String, trim: true, uppercase: true, maxlength: 50, required: true },

    nameHe: { type: String, trim: true, maxlength: 120, required: true },
    nameAr: { type: String, trim: true, maxlength: 120, required: true },

    descHe: { type: String, trim: true, maxlength: 400, default: "" },
    descAr: { type: String, trim: true, maxlength: 400, default: "" },

    // minor units
    basePrice: {
      type: Number,
      default: 0,
      validate: { validator: intMin0, message: "basePrice must be integer >= 0" },
    },

    // if payableSubtotal >= freeAbove => computedPrice=0
    freeAbove: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || intMin0(v), message: "freeAbove invalid" },
    },

    minSubtotal: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || intMin0(v), message: "minSubtotal invalid" },
    },
    maxSubtotal: {
      type: Number,
      default: null,
      validate: { validator: (v) => v === null || intMin0(v), message: "maxSubtotal invalid" },
    },

    // optional allowlist; store normalized (lowercase) for faster compare
    cities: { type: [String], default: [] },

    sort: { type: Number, default: 100, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, strict: true },
);

ShippingMethodSchema.index({ code: 1 }, { unique: true });
ShippingMethodSchema.index({ isActive: 1, sort: 1 });
ShippingMethodSchema.index({ sort: 1, createdAt: -1 });

baseToJSON(ShippingMethodSchema);

export const ShippingMethod = getOrCreateModel("ShippingMethod", ShippingMethodSchema);
export default ShippingMethod;
