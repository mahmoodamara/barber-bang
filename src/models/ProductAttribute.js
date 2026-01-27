// src/models/ProductAttribute.js
import mongoose from "mongoose";

const optionSchema = new mongoose.Schema(
  {
    valueKey: { type: String, required: true, trim: true, maxlength: 80 },
    labelHe: { type: String, default: "", trim: true, maxlength: 120 },
    labelAr: { type: String, default: "", trim: true, maxlength: 120 },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const productAttributeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 80 },
    nameHe: { type: String, default: "", trim: true, maxlength: 120 },
    nameAr: { type: String, default: "", trim: true, maxlength: 120 },
    type: { type: String, enum: ["text", "number", "enum"], required: true },
    unit: { type: String, default: "", trim: true, maxlength: 20 },
    options: { type: [optionSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

function normalizeKey(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  return v
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

productAttributeSchema.pre("validate", function normalizeAttribute(next) {
  try {
    this.key = normalizeKey(this.key);
    if (!this.key) return next(new Error("key is required"));

    if (Array.isArray(this.options)) {
      const seen = new Set();
      this.options = this.options.map((opt) => {
        const out = { ...(opt?.toObject?.() || opt) };
        out.valueKey = normalizeKey(out.valueKey);
        if (!out.valueKey) {
          throw new Error("options.valueKey is required");
        }
        if (seen.has(out.valueKey)) {
          throw new Error("Duplicate options.valueKey within attribute");
        }
        seen.add(out.valueKey);
        return out;
      });
    }

    return next();
  } catch (e) {
    return next(e);
  }
});

productAttributeSchema.index({ key: 1 }, { unique: true });

export const ProductAttribute = mongoose.model("ProductAttribute", productAttributeSchema);
