import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

const EmailOtpTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    emailLower: { type: String, trim: true, lowercase: true, required: true, index: true },
    purpose: { type: String, trim: true, required: true, index: true },
    codeHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    ip: { type: String, trim: true, maxlength: 64, default: null },
    userAgent: { type: String, trim: true, maxlength: 200, default: null },
  },
  { timestamps: false, strict: true },
);

EmailOtpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

baseToJSON(EmailOtpTokenSchema);

export const EmailOtpToken = getOrCreateModel("EmailOtpToken", EmailOtpTokenSchema);
export default EmailOtpToken;
