// src/models/User.js
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { baseToJSON, getOrCreateModel } from "./_helpers.js";

const { Schema } = mongoose;

const BCRYPT_ROUNDS = (() => {
  const raw = Number(process.env.BCRYPT_COST || 12);
  return Number.isFinite(raw) && raw >= 12 ? raw : 12;
})();

function trimOrUndef(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function normPhone(v) {
  const s = trimOrUndef(v);
  if (!s) return undefined;
  // keep + and digits only
  const cleaned = s.replace(/[^\d+]/g, "");
  return cleaned || undefined;
}

function bool(v) {
  return v === true;
}

const AddressSchema = new Schema(
  {
    label: { type: String, trim: true, maxlength: 60, default: "" }, // Home/Work...
    fullName: { type: String, trim: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 30, default: "" },

    country: { type: String, trim: true, maxlength: 80, default: "Israel" },
    city: { type: String, trim: true, maxlength: 120, required: true },
    street: { type: String, trim: true, maxlength: 200, required: true },
    building: { type: String, trim: true, maxlength: 50, default: "" },
    apartment: { type: String, trim: true, maxlength: 50, default: "" },
    zip: { type: String, trim: true, maxlength: 30, default: "" },

    notes: { type: String, trim: true, maxlength: 500, default: "" },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: false },
);

// Small helper index for quick default fetch per-user (within the embedded array)
AddressSchema.index({ isDefault: 1 });

const UserSchema = new Schema(
  {
    email: { type: String, trim: true, maxlength: 254, default: undefined },
    emailLower: { type: String, trim: true, lowercase: true, maxlength: 254, default: undefined }, // normalized
    phone: { type: String, trim: true, maxlength: 30, default: undefined },

    // IMPORTANT: keep passwordHash select:false to avoid leaking in queries.
    passwordHash: { type: String, trim: true, minlength: 20, select: false },

    roles: { type: [String], default: ["user"], index: true }, // user/staff/admin
    segments: { type: [String], default: [], index: true },

    // Granular permissions (RBAC v2):
    // - Admin role is treated as full-access in middleware (defense-in-depth).
    // - Staff users should be granted explicit permissions here.
    permissions: { type: [String], default: [], index: true },
    isActive: { type: Boolean, default: true, index: true },
    tokenVersion: { type: Number, default: 0 },
    emailVerified: { type: Boolean, default: false, index: true },
    emailVerifiedAt: { type: Date, default: null },
    emailVerificationSentAt: { type: Date, default: null },

    failedLoginCount: { type: Number, default: 0 },
    loginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    lastFailedLoginAt: { type: Date, default: null },

    addresses: { type: [AddressSchema], default: [] },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);

/**
 * Indexes
 * - sparse unique so users can exist without email/phone
 * - normalize "" to undefined so sparse unique won't conflict
 */
UserSchema.index({ emailLower: 1 }, { unique: true, sparse: true });
UserSchema.index({ phone: 1 }, { unique: true, sparse: true });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ lastLoginAt: -1 });

/**
 * Normalize fields + enforce single default address (model-level safety net)
 * - Keep services as the main guard, but this prevents bad writes from anywhere.
 */
UserSchema.pre("validate", function normalizeUser(next) {
  // Email normalize (avoid wiping fields on partial selects)
  const normalizeEmail = this.isNew || this.isModified("email") || this.isSelected("email");
  if (normalizeEmail) {
    const e = trimOrUndef(this.email);
    this.email = e;
    this.emailLower = e ? e.toLowerCase() : undefined;
  }

  // Phone normalize (keep in E.164-ish shape, but soft)
  const normalizePhone = this.isNew || this.isModified("phone") || this.isSelected("phone");
  if (normalizePhone) {
    const p = normPhone(this.phone);
    this.phone = p;
  }

  // Segments normalize (upper-case + de-dupe)
  if (Array.isArray(this.segments)) {
    const seen = new Set();
    const normalized = [];
    for (const seg of this.segments) {
      const v = String(seg || "").trim().toUpperCase();
      if (!v) continue;
      if (v.length > 40) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      normalized.push(v);
      if (normalized.length >= 50) break;
    }
    this.segments = normalized;
  }

  // Addresses normalize + single default
  if (Array.isArray(this.addresses)) {
    let hasDefault = false;

    for (const a of this.addresses) {
      if (!a) continue;

      // normalize strings (avoid nulls)
      a.label = String(a.label ?? "").trim();
      a.fullName = String(a.fullName ?? "").trim();
      a.phone = String(a.phone ?? "").trim();

      a.country = String(a.country ?? "Israel").trim() || "Israel";
      a.city = String(a.city ?? "").trim();
      a.street = String(a.street ?? "").trim();
      a.building = String(a.building ?? "").trim();
      a.apartment = String(a.apartment ?? "").trim();
      a.zip = String(a.zip ?? "").trim();
      a.notes = String(a.notes ?? "").trim();

      // enforce single default
      if (bool(a.isDefault)) {
        if (hasDefault) a.isDefault = false;
        else hasDefault = true;
      } else {
        a.isDefault = false;
      }
    }

    // If there are addresses but none default, set first as default
    if (this.addresses.length > 0 && !hasDefault) {
      this.addresses[0].isDefault = true;
    }
  }

  next();
});

UserSchema.methods.setPassword = async function setPassword(password) {
  const raw = String(password || "");
  this.passwordHash = await bcrypt.hash(raw, BCRYPT_ROUNDS);
};

UserSchema.methods.verifyPassword = async function verifyPassword(password) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(password || ""), this.passwordHash);
};

UserSchema.methods.isLocked = function isLocked(now = new Date()) {
  if (!this.lockUntil) return false;
  const ts = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  return this.lockUntil.getTime() > ts;
};

UserSchema.methods.incLoginAttempts = function incLoginAttempts({
  lockMs = 0,
  now = new Date(),
  nextCount,
} = {}) {
  const current = Math.max(Number(this.loginAttempts || 0), Number(this.failedLoginCount || 0));
  const count = Number.isFinite(nextCount) ? nextCount : current + 1;
  const when = now instanceof Date ? now : new Date(now);
  this.loginAttempts = count;
  this.failedLoginCount = count;
  this.lastFailedLoginAt = when;
  if (lockMs) this.lockUntil = new Date(when.getTime() + lockMs);
  return count;
};

UserSchema.methods.resetLoginAttempts = function resetLoginAttempts() {
  this.loginAttempts = 0;
  this.failedLoginCount = 0;
  this.lockUntil = null;
  this.lastFailedLoginAt = null;
};

baseToJSON(UserSchema);

export const User = getOrCreateModel("User", UserSchema);
export default User;

export const UserRoles = Object.freeze({
  USER: "user",
  STAFF: "staff",
  ADMIN: "admin",
});
