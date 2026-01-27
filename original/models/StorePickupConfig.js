import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    isEnabled: { type: Boolean, default: true },
    fee: { type: Number, default: 0, min: 0 },
    addressHe: { type: String, default: "", trim: true, maxlength: 220 },
    addressAr: { type: String, default: "", trim: true, maxlength: 220 },
    notesHe: { type: String, default: "", trim: true, maxlength: 800 },
    notesAr: { type: String, default: "", trim: true, maxlength: 800 },
    // legacy
    address: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

schema.index({ createdAt: -1 });

export const StorePickupConfig = mongoose.model("StorePickupConfig", schema);
