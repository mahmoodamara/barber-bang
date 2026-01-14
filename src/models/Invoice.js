import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const InvoiceSchema = new Schema(
  {
    orderId: { type: Types.ObjectId, ref: "Order", required: true },
    invoiceNumber: { type: String, trim: true, maxlength: 60 },

    lang: { type: String, enum: ["he", "ar"], default: "he" },

    currency: { type: String, trim: true, uppercase: true, default: "ILS", maxlength: 10 },
    grandTotal: { type: Number, required: true, min: 0 },

    fileKey: { type: String, trim: true, maxlength: 500 },
    fileUrl: { type: String, trim: true, maxlength: 2000 },

    issuedAt: { type: Date, default: Date.now },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);

InvoiceSchema.index({ orderId: 1 }, { unique: true });
InvoiceSchema.index({ invoiceNumber: 1 }, { unique: true, sparse: true });
InvoiceSchema.index({ issuedAt: -1 });
InvoiceSchema.index({ createdAt: -1 });

baseToJSON(InvoiceSchema);

export const Invoice = getOrCreateModel("Invoice", InvoiceSchema);
export default Invoice;
