import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    nameHe: { type: String, required: true, trim: true, maxlength: 160 },
    nameAr: { type: String, default: "", trim: true, maxlength: 160 },
    addressHe: { type: String, required: true, trim: true, maxlength: 220 },
    addressAr: { type: String, default: "", trim: true, maxlength: 220 },
    // legacy
    name: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    fee: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

schema.index({ isActive: 1, createdAt: -1 });

export const PickupPoint = mongoose.model("PickupPoint", schema);
