import crypto from "node:crypto";
import { ENV } from "./env.js";
import { safeEqual } from "./authTokens.js";

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)?$/i;

function parseDurationMs(value, fallbackMs) {
  if (value === undefined || value === null || value === "") return fallbackMs;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, value);
  const str = String(value).trim();
  const match = DURATION_RE.exec(str);
  if (!match) return fallbackMs;
  const count = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const mult = multipliers[unit] || 1000;
  return Math.max(1, count * mult);
}

function getOtpPepper() {
  const pepper = String(ENV.OTP_PEPPER || "").trim();
  if (pepper) return pepper;
  if (ENV.NODE_ENV === "production") {
    throw new Error("OTP_PEPPER is required in production");
  }
  return "dev_otp_pepper";
}

export function getEmailOtpTtlMs() {
  return parseDurationMs(ENV.EMAIL_OTP_TTL || "10m", 10 * 60_000);
}

export function getEmailOtpResendCooldownMs() {
  const raw = Number(ENV.EMAIL_OTP_RESEND_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

export function generateOtpCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, "0");
}

export function hashOtp(code) {
  const pepper = getOtpPepper();
  return crypto.createHash("sha256").update(String(code) + pepper).digest("hex");
}

export function verifyOtpHash(code, codeHash) {
  const hashed = hashOtp(code);
  return safeEqual(hashed, codeHash);
}
