import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

function intMin1(v) {
  return Number.isInteger(v) && v >= 1;
}

function intMin0(v) {
  return Number.isInteger(v) && v >= 0;
}

function trimOrEmpty(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function trimOrNull(v) {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s.length ? s : null;
}

const ReturnItemSnapshotSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", default: null, index: true },
    skuSnapshot: { type: String, trim: true, maxlength: 80, default: "" },
    nameHeSnapshot: { type: String, trim: true, maxlength: 180, default: "" },
    nameArSnapshot: { type: String, trim: true, maxlength: 180, default: "" },
    unitPrice: { type: Number, default: 0, validate: { validator: intMin0, message: "unitPrice must be int >= 0" } },
    currency: { type: String, trim: true, uppercase: true, maxlength: 10, default: "ILS" },
  },
  { _id: false },
);

const ReturnItemSchema = new Schema(
  {
    orderItemId: { type: Types.ObjectId, required: true, index: true },
    variantId: { type: Types.ObjectId, ref: "Variant", required: true, index: true },
    quantity: { type: Number, required: true, validate: { validator: intMin1, message: "quantity must be int >= 1" } },

    action: { type: String, enum: ["refund", "exchange"], required: true, index: true },

    reasonCode: { type: String, trim: true, maxlength: 80, default: "" },
    reasonText: { type: String, trim: true, maxlength: 500, default: null },
    condition: { type: String, trim: true, maxlength: 80, default: null },
    photos: { type: [String], default: [] },

    snapshot: { type: ReturnItemSnapshotSchema, default: null },
  },
  { _id: false },
);

const ExchangeItemSchema = new Schema(
  {
    variantId: { type: Types.ObjectId, ref: "Variant", required: true, index: true },
    quantity: { type: Number, required: true, validate: { validator: intMin1, message: "quantity must be int >= 1" } },
  },
  { _id: false },
);

const ExchangeSchema = new Schema(
  {
    items: { type: [ExchangeItemSchema], default: [] },
    reservationId: { type: Types.ObjectId, default: null, index: true },
    priceDiffMinor: {
      type: Number,
      default: null,
      validate: {
        validator: (v) => v === null || intMin0(v),
        message: "priceDiffMinor must be int >= 0",
      },
    },
  },
  { _id: false },
);

const ReturnRequestSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: Types.ObjectId, ref: "Order", required: true, index: true },

    items: { type: [ReturnItemSchema], default: [] },

    status: {
      type: String,
      enum: ["requested", "approved", "rejected", "received", "refunded", "exchanged", "canceled"],
      default: "requested",
      index: true,
    },

    requestedAt: { type: Date, default: Date.now, index: true },
    decidedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    customerNote: { type: String, set: trimOrEmpty, maxlength: 1000, default: "" },
    adminNote: { type: String, set: trimOrEmpty, maxlength: 2000, default: "" },

    exchange: { type: ExchangeSchema, default: null },
  },
  { timestamps: true, strict: true },
);

// INDEXES
ReturnRequestSchema.index({ userId: 1, createdAt: -1 });
ReturnRequestSchema.index({ orderId: 1, createdAt: -1 });
ReturnRequestSchema.index({ status: 1, createdAt: -1, _id: -1 });

// Prevent multiple active returns for same orderItemId (per order)
ReturnRequestSchema.index(
  { orderId: 1, "items.orderItemId": 1 },
  {
    unique: true,
    name: "uniq_active_order_orderItem",
    partialFilterExpression: { status: { $in: ["requested", "approved", "received"] } },
  },
);

ReturnRequestSchema.pre("validate", function normalize(next) {
  if (Array.isArray(this.items)) {
    for (const it of this.items) {
      if (it) {
        it.reasonCode = trimOrEmpty(it.reasonCode);
        it.reasonText = trimOrNull(it.reasonText);
        it.condition = trimOrNull(it.condition);
        if (Array.isArray(it.photos)) it.photos = it.photos.map((u) => String(u)).filter(Boolean).slice(0, 12);
      }
    }
  }
  next();
});

baseToJSON(ReturnRequestSchema);

export const ReturnRequest = getOrCreateModel("ReturnRequest", ReturnRequestSchema);
export default ReturnRequest;
