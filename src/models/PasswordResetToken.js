import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

const PasswordResetTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, minlength: 64, maxlength: 64 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    ip: { type: String, trim: true, maxlength: 64, default: null },
    userAgent: { type: String, trim: true, maxlength: 200, default: null },
  },
  { timestamps: false, strict: true },
);

PasswordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

baseToJSON(PasswordResetTokenSchema);

export const PasswordResetToken = getOrCreateModel("PasswordResetToken", PasswordResetTokenSchema);
export default PasswordResetToken;
