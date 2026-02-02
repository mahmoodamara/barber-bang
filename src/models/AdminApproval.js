// src/models/AdminApproval.js
/**
 * Admin approval workflow (e.g. REFUND). Staff creates request; admin approves; system executes.
 */
import mongoose from "mongoose";

const payloadSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    amount: { type: Number, default: null },
    reason: { type: String, default: "" },
    note: { type: String, default: "" },
    items: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const adminApprovalSchema = new mongoose.Schema(
  {
    actionType: {
      type: String,
      required: true,
      trim: true,
      enum: ["REFUND"],
      index: true,
    },
    payload: { type: payloadSchema, required: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "approved", "rejected", "executed"],
      default: "pending",
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 256,
    },
    executedAt: { type: Date, default: null },
    executedResult: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

adminApprovalSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
adminApprovalSchema.index({ "payload.orderId": 1, actionType: 1, status: 1 });
adminApprovalSchema.index({ createdAt: -1 });

export const AdminApproval = mongoose.model("AdminApproval", adminApprovalSchema);
