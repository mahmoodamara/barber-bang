import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema, Types } = mongoose;

const NotificationLogSchema = new Schema(
  {
    event: { type: String, trim: true, maxlength: 80, required: true, index: true },
    channel: { type: String, enum: ["email"], default: "email", index: true },

    status: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      default: "pending",
      index: true,
    },

    // recipient
    to: { type: String, trim: true, maxlength: 254, default: null, index: true },

    subject: { type: String, trim: true, maxlength: 200, default: "" },
    text: { type: String, trim: true, maxlength: 20_000, default: "" },
    html: { type: String, trim: true, maxlength: 50_000, default: "" },

    // linkage
    orderId: { type: Types.ObjectId, ref: "Order", default: null, index: true },
    returnId: { type: Types.ObjectId, ref: "ReturnRequest", default: null, index: true },

    dedupeKey: { type: String, trim: true, maxlength: 200, default: null },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, trim: true, maxlength: 300, default: null },

    sentAt: { type: Date, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, strict: true },
);

NotificationLogSchema.index({ status: 1, createdAt: -1 });
NotificationLogSchema.index({ event: 1, createdAt: -1 });

NotificationLogSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

baseToJSON(NotificationLogSchema);

export const NotificationLog = getOrCreateModel("NotificationLog", NotificationLogSchema);
export default NotificationLog;

