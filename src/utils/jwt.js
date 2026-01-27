import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ALG = "HS256";

// ✅ Defaults (secure-by-default)
const JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m"; // access token short-lived
const JWT_ISSUER = process.env.JWT_ISSUER || "barber-store-api";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "barber-store-client";

// Backward compatible env name (old)
const LEGACY_EXPIRES_IN = process.env.JWT_EXPIRES_IN; // if exists, used only when explicitly passed

function assertJwtConfig() {
  if (!JWT_SECRET || typeof JWT_SECRET !== "string" || JWT_SECRET.length < 16) {
    // length < 16 is a weak secret signal
    throw new Error("JWT_SECRET is missing or too weak (min length 16).");
  }
}

/**
 * Sign an Access Token (short-lived by default)
 * @param {object} payload - token payload (e.g. { userId, role, tokenVersion })
 * @param {object} options - optional override { expiresIn }
 */
export function signToken(payload, options = {}) {
  assertJwtConfig();

  const normalized = { ...(payload || {}) };

  // ✅ standardize subject claim
  if (!normalized.sub && normalized.userId) normalized.sub = String(normalized.userId);

  // ✅ remove duplicate claim if present
  if (normalized.userId && normalized.sub === String(normalized.userId)) {
    // keep both if your system still depends on userId, otherwise remove userId
    // delete normalized.userId;
  }

  const expiresIn =
    options.expiresIn ||
    JWT_ACCESS_EXPIRES_IN ||
    LEGACY_EXPIRES_IN ||
    "15m";

  return jwt.sign(normalized, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

/**
 * Verify a JWT token securely
 * - Enforces algorithm allowlist
 * - Validates issuer + audience
 * @param {string} token
 */
export function verifyToken(token) {
  assertJwtConfig();

  if (!token || typeof token !== "string") {
    const err = new Error("Missing token");
    err.code = "TOKEN_MISSING";
    throw err;
  }

  try {
    return jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALG],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch (e) {
    // ✅ normalize error without leaking secret details
    const err = new Error("Invalid or expired token");
    err.code = "TOKEN_INVALID";
    err.name = e?.name || "JsonWebTokenError";
    throw err;
  }
}

/**
 * Optional helper: sign refresh token (longer-lived)
 * Use only if you implement refresh flow.
 */
export function signRefreshToken(payload, options = {}) {
  assertJwtConfig();

  const normalized = { ...(payload || {}) };
  if (!normalized.sub && normalized.userId) normalized.sub = String(normalized.userId);

  const refreshExpiresIn = options.expiresIn || process.env.JWT_REFRESH_EXPIRES_IN || "30d";

  return jwt.sign(normalized, JWT_SECRET, {
    algorithm: JWT_ALG,
    expiresIn: refreshExpiresIn,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}
