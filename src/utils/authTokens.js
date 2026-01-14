import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { ENV } from "./env.js";

export const REFRESH_COOKIE_NAME = "refreshToken";

const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_TTL || ENV.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TOKEN_TTL = process.env.JWT_REFRESH_TTL || "30d";
const PASSWORD_RESET_TTL = process.env.PASSWORD_RESET_TTL || "30m";

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

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function normalizeSameSite(value) {
  const s = String(value || "lax").trim().toLowerCase();
  if (s === "none" || s === "strict" || s === "lax") return s;
  return "lax";
}

function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function getJwtSecrets() {
  const current = process.env.JWT_SECRET_CURRENT || ENV.JWT_SECRET;
  const previous = process.env.JWT_SECRET_PREVIOUS;
  const secrets = [];
  if (current) secrets.push(current);
  if (previous && previous !== current) secrets.push(previous);
  return secrets;
}

export function signAccessToken({ userId, roles, emailLower, tokenVersion }) {
  const [secret] = getJwtSecrets();
  const tv = Number(tokenVersion || 0);
  const payload = {
    roles: Array.isArray(roles) ? roles : ["user"],
    email: emailLower,
    tokenVersion: tv,
    tv,
    jti: crypto.randomUUID(),
  };

  return jwt.sign(payload, secret, {
    subject: String(userId),
    issuer: ENV.JWT_ISSUER,
    audience: ENV.JWT_AUDIENCE,
    expiresIn: ACCESS_TOKEN_TTL,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token) {
  const secrets = getJwtSecrets();
  let lastErr;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret, {
        issuer: ENV.JWT_ISSUER,
        audience: ENV.JWT_AUDIENCE,
        algorithms: ["HS256"],
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("AUTH_INVALID");
}

export function getRefreshTokenTtlMs() {
  return parseDurationMs(REFRESH_TOKEN_TTL, 30 * 24 * 60 * 60_000);
}

export function getPasswordResetTtlMs() {
  return parseDurationMs(PASSWORD_RESET_TTL, 30 * 60_000);
}

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getRefreshCookieOptions(maxAgeMs) {
  const secureDefault = ENV.NODE_ENV === "production";
  const secure = parseBool(process.env.COOKIE_SECURE, secureDefault);
  const sameSite = normalizeSameSite(process.env.COOKIE_SAMESITE);
  const domain = process.env.COOKIE_DOMAIN ? String(process.env.COOKIE_DOMAIN) : undefined;
  const opts = {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
  };
  if (domain) opts.domain = domain;
  if (Number.isFinite(maxAgeMs)) opts.maxAge = Math.max(1, Math.floor(maxAgeMs));
  return opts;
}

export function getRefreshTokenFromReq(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie);
  return cookies[REFRESH_COOKIE_NAME] || null;
}

export function setRefreshCookie(res, token, maxAgeMs) {
  const opts = getRefreshCookieOptions(maxAgeMs);
  res.cookie(REFRESH_COOKIE_NAME, token, opts);
}

export function clearRefreshCookie(res) {
  const opts = getRefreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, opts);
}
