import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const VariantSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },

    sku: { type: String, trim: true, maxlength: 80, required: true },
    barcode: { type: String, trim: true, maxlength: 80 },

    price: { type: Number, required: true, min: 0 }, // minor units
    currency: { type: String, trim: true, uppercase: true, default: "ILS", maxlength: 10 },

    stock: { type: Number, default: 0, min: 0 },
    stockReserved: { type: Number, default: 0, min: 0 },

    options: { type: Map, of: Schema.Types.Mixed, default: {} },

    isActive: { type: Boolean, default: true, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, strict: true },
);

const NOT_DELETED = { isDeleted: { $ne: true } };

VariantSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: NOT_DELETED });
VariantSchema.index({ productId: 1, sortOrder: 1 }, { partialFilterExpression: NOT_DELETED });
VariantSchema.index({ isActive: 1, productId: 1 }, { partialFilterExpression: NOT_DELETED });
VariantSchema.index(
  { barcode: 1 },
  { sparse: true, unique: true, partialFilterExpression: NOT_DELETED },
);

baseToJSON(VariantSchema);

export const Variant = getOrCreateModel("Variant", VariantSchema);
export default Variant;
