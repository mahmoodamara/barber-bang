// src/services/auth.service.js
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { RefreshSession } from "../models/RefreshSession.js";
import { PasswordResetToken } from "../models/PasswordResetToken.js";
import { EmailOtpToken } from "../models/EmailOtpToken.js";
import { sendEmailOtp, sendPasswordResetEmail } from "./mail.service.js";
import {
  generateToken,
  getPasswordResetTtlMs,
  getRefreshTokenTtlMs,
  hashToken,
  safeEqual,
  signAccessToken,
} from "../utils/authTokens.js";
import {
  generateOtpCode,
  getEmailOtpResendCooldownMs,
  getEmailOtpTtlMs,
  hashOtp,
  verifyOtpHash,
} from "../utils/otp.js";

/**
 * Notes / fixes vs your current version:
 * - Prevent bcrypt DoS: clamp password length before hashing/compare.
 * - Avoid timing/user-enumeration signals: always run a bcrypt compare on failures.
 * - Lockout logic: keep lock state, but return generic INVALID_CREDENTIALS (safer).
 * - Refresh rotation: make it atomic to prevent concurrent refresh replay (race condition).
 * - Ensure old reset tokens are invalidated after successful reset.
 */

const LOCKOUT_POLICY = [
  { threshold: 5, lockMs: 5 * 60_000 },
  { threshold: 8, lockMs: 15 * 60_000 },
  { threshold: 10, lockMs: 60 * 60_000 },
];

// precomputed bcrypt hash to equalize timing when user doesn't exist
const DUMMY_PASSWORD_HASH = "$2a$12$ZVtf8ROJP.ghw9X4Jd7ryewKw9s2EfqpVt5cj0rnF2QDX/FRVA86m";

// hard clamp to reduce bcrypt CPU amplification
const MAX_PASSWORD_LEN = Number.isFinite(Number(process.env.AUTH_MAX_PASSWORD_LEN))
  ? Math.max(64, Number(process.env.AUTH_MAX_PASSWORD_LEN))
  : 200;

function clampPassword(v) {
  return String(v ?? "").slice(0, MAX_PASSWORD_LEN);
}

function lockoutMs(failedCount) {
  let ms = 0;
  for (const step of LOCKOUT_POLICY) {
    if (failedCount >= step.threshold) ms = step.lockMs;
  }
  return ms;
}

function authError(statusCode, code) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeEmail(email) {
  const rawEmail = String(email || "").trim();
  return { rawEmail, emailLower: rawEmail ? rawEmail.toLowerCase() : "" };
}

function normalizeMeta({ ip, userAgent } = {}) {
  const cleanIp = typeof ip === "string" ? ip.trim().slice(0, 64) : "";
  const cleanUa = typeof userAgent === "string" ? userAgent.trim().slice(0, 200) : "";
  return { ip: cleanIp || null, userAgent: cleanUa || null };
}

async function consumeSomeCpuOnFailure(password, passwordHashOrDummy) {
  // Equalize timing across: user-not-found, inactive, locked, wrong password.
  // bcrypt.compare is the main equalizer; keep it always happening on failure paths.
  const pwd = clampPassword(password);
  const hash = passwordHashOrDummy || DUMMY_PASSWORD_HASH;
  try {
    await bcrypt.compare(pwd, hash);
  } catch {
    // ignore
  }
}

async function createRefreshSession({ userId, ip, userAgent }) {
  const ttlMs = getRefreshTokenTtlMs();
  const expiresAt = new Date(Date.now() + ttlMs);
  const meta = normalizeMeta({ ip, userAgent });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refreshToken = generateToken();
    const tokenHash = hashToken(refreshToken);

    try {
      await RefreshSession.create({
        userId,
        tokenHash,
        createdAt: new Date(),
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { refreshToken, refreshTtlMs: ttlMs };
    } catch (err) {
      // rare collision, retry once
      if (err?.code === 11000 && attempt === 0) continue;
      throw err;
    }
  }

  throw new Error("REFRESH_SESSION_CREATE_FAILED");
}

// ───────────────────────────────────────────────────────────────
// REGISTER
// ───────────────────────────────────────────────────────────────

export async function registerUser({ email, password, phone }) {
  const { rawEmail, emailLower } = normalizeEmail(email);
  if (!rawEmail) throw authError(400, "EMAIL_REQUIRED");

  const exists = await User.findOne({ emailLower }).lean();
  if (exists) throw authError(409, "EMAIL_ALREADY_EXISTS");

  const safePhone =
    typeof phone === "string" && phone.trim() ? phone.trim().slice(0, 30) : undefined;

  const user = new User({
    email: rawEmail,
    emailLower,
    phone: safePhone,
    roles: ["user"],
    isActive: true,
  });

  await user.setPassword(clampPassword(password));

  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) {
      const key = err?.keyPattern || err?.keyValue || {};
      const code = key.emailLower
        ? "EMAIL_ALREADY_EXISTS"
        : key.phone
          ? "PHONE_ALREADY_EXISTS"
          : "DUPLICATE_KEY";
      throw authError(409, code);
    }
    throw err;
  }

  return user;
}

// ───────────────────────────────────────────────────────────────
// LOGIN
// ───────────────────────────────────────────────────────────────

export async function loginUser({ email, password, ip, userAgent, requestId }) {
  const { emailLower } = normalizeEmail(email);
  const pwd = clampPassword(password);

  const user = await User.findOne({ emailLower }).select(
    "+passwordHash roles isActive tokenVersion failedLoginCount loginAttempts lockUntil lastFailedLoginAt emailLower emailVerified emailVerificationSentAt",
  );

  // Generic invalid credentials (safer: reduces account enumeration).
  const invalid = async () => {
    await consumeSomeCpuOnFailure(pwd, user?.passwordHash || DUMMY_PASSWORD_HASH);
    throw authError(401, "INVALID_CREDENTIALS");
  };

  if (!user || !user.isActive) {
    await consumeSomeCpuOnFailure(pwd, DUMMY_PASSWORD_HASH);
    throw authError(401, "INVALID_CREDENTIALS");
  }

  const now = new Date();

  // If locked, do NOT reveal lock status; just behave like invalid credentials.
  if (user.isLocked && user.isLocked(now)) {
    return invalid();
  }

  // lock expired -> clear attempts
  if (user.lockUntil && user.lockUntil <= now) {
    if (user.resetLoginAttempts) user.resetLoginAttempts();
  }

  const ok = await user.verifyPassword(pwd);
  if (!ok) {
    const current = Math.max(Number(user.loginAttempts || 0), Number(user.failedLoginCount || 0));
    const nextCount = current + 1;
    const lockMs = lockoutMs(nextCount);

    if (user.incLoginAttempts) {
      user.incLoginAttempts({ lockMs, now, nextCount });
    } else {
      user.failedLoginCount = nextCount;
      user.loginAttempts = nextCount;
      user.lastFailedLoginAt = now;
      if (lockMs) user.lockUntil = new Date(now.getTime() + lockMs);
    }

    await user.save();
    return invalid();
  }

  if (!user.emailVerified) {
    await issueEmailVerificationOtp({ user, ip, userAgent, requestId });
    throw authError(403, "EMAIL_NOT_VERIFIED");
  }

  // success
  user.lastLoginAt = now;
  if (user.resetLoginAttempts) {
    user.resetLoginAttempts();
  } else {
    user.failedLoginCount = 0;
    user.loginAttempts = 0;
    user.lockUntil = null;
    user.lastFailedLoginAt = null;
  }
  await user.save();

  const token = signAccessToken({
    userId: user._id.toString(),
    roles: user.roles,
    emailLower: user.emailLower,
    tokenVersion: user.tokenVersion || 0,
  });

  const session = await createRefreshSession({ userId: user._id, ip, userAgent });

  // avoid accidental leaks if someone spreads user object
  user.passwordHash = undefined;

  return { user, token, refreshToken: session.refreshToken, refreshTtlMs: session.refreshTtlMs };
}

// ───────────────────────────────────────────────────────────────
// REFRESH (ROTATION) — atomic to prevent replay races
// ───────────────────────────────────────────────────────────────

export async function refreshSession({ refreshToken, ip, userAgent }) {
  if (!refreshToken) throw authError(401, "AUTH_REQUIRED");

  const tokenHash = hashToken(refreshToken);
  const now = new Date();

  // Atomic: only one request can rotate/revoke the same session successfully.
  const session = await RefreshSession.findOneAndUpdate(
    {
      tokenHash,
      revokedAt: null,
      rotatedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        rotatedAt: now,
        revokedAt: now,
      },
    },
    { new: false }, // we don't need the updated doc, just the original
  );

  // timing-safe check still useful when session exists but hash mismatch would be impossible due to query,
  // so we keep a minimal safeEqual guard for consistency if schema ever changes.
  if (!session || !safeEqual(session.tokenHash, tokenHash)) {
    throw authError(401, "AUTH_INVALID");
  }

  const user = await User.findById(session.userId).select("roles isActive tokenVersion emailLower");
  if (!user || !user.isActive) throw authError(401, "AUTH_INVALID");

  const token = signAccessToken({
    userId: user._id.toString(),
    roles: user.roles,
    emailLower: user.emailLower,
    tokenVersion: user.tokenVersion || 0,
  });

  const nextSession = await createRefreshSession({ userId: user._id, ip, userAgent });

  return {
    user,
    token,
    refreshToken: nextSession.refreshToken,
    refreshTtlMs: nextSession.refreshTtlMs,
  };
}

// ───────────────────────────────────────────────────────────────
// LOGOUT(S)
// ───────────────────────────────────────────────────────────────

export async function logoutSession({ refreshToken }) {
  if (!refreshToken) return { revoked: false };

  const tokenHash = hashToken(refreshToken);
  const session = await RefreshSession.findOne({ tokenHash });
  if (!session || !safeEqual(session.tokenHash, tokenHash)) return { revoked: false };

  if (!session.revokedAt) {
    session.revokedAt = new Date();
    await session.save();
  }

  return { revoked: true, userId: session.userId };
}

export async function logoutAllSessions({ userId }) {
  if (!userId) throw authError(401, "AUTH_REQUIRED");

  const user = await User.findById(userId).select("tokenVersion emailLower roles isActive");
  if (!user || !user.isActive) throw authError(401, "AUTH_INVALID");

  // Bump tokenVersion to invalidate all existing access tokens
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  await user.save();

  const now = new Date();
  await RefreshSession.updateMany({ userId: user._id }, { $set: { revokedAt: now } });

  return user;
}

// ───────────────────────────────────────────────────────────────
// PASSWORD RESET
// ───────────────────────────────────────────────────────────────

export async function forgotPassword({ email, ip, userAgent }) {
  const { emailLower } = normalizeEmail(email);
  if (!emailLower) return { ok: true };

  const user = await User.findOne({ emailLower }).select("emailLower isActive").lean();
  if (!user || !user.isActive) return { ok: true };

  const ttlMs = getPasswordResetTtlMs();
  const expiresAt = new Date(Date.now() + ttlMs);
  const meta = normalizeMeta({ ip, userAgent });

  // single active token per user
  await PasswordResetToken.deleteMany({ userId: user._id });

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  await PasswordResetToken.create({
    userId: user._id,
    tokenHash,
    createdAt: new Date(),
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  // Always return ok:true (do not reveal if email exists).
  try {
    await sendPasswordResetEmail({ to: user.emailLower, token: rawToken });
  } catch {
    // swallow
  }

  return { ok: true };
}

export async function resetPassword({ token, password }) {
  const rawToken = String(token || "").trim();
  if (!rawToken) throw authError(400, "RESET_TOKEN_INVALID");

  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const reset = await PasswordResetToken.findOne({ tokenHash });
  if (!reset || !safeEqual(reset.tokenHash, tokenHash)) throw authError(400, "RESET_TOKEN_INVALID");

  if (reset.usedAt || (reset.expiresAt && reset.expiresAt <= now)) {
    // mark used once (helps forensic/audit), then reject
    if (!reset.usedAt) {
      reset.usedAt = now;
      await reset.save();
    }
    throw authError(400, "RESET_TOKEN_INVALID");
  }

  const user = await User.findById(reset.userId).select(
    "+passwordHash tokenVersion isActive emailLower roles",
  );
  if (!user || !user.isActive) throw authError(400, "RESET_TOKEN_INVALID");

  await user.setPassword(clampPassword(password));

  // Invalidate all existing access tokens & refresh sessions
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  if (user.resetLoginAttempts) user.resetLoginAttempts();
  await user.save();

  // Mark this token used and delete any other outstanding reset tokens for the user
  reset.usedAt = now;
  await reset.save();
  await PasswordResetToken.deleteMany({ userId: user._id, _id: { $ne: reset._id } });

  await RefreshSession.updateMany({ userId: user._id }, { $set: { revokedAt: now } });

  user.passwordHash = undefined;
  return { user };
}

// =============================================================================
// EMAIL OTP VERIFICATION
// =============================================================================
// Manual verification notes:
// 1) Register -> user.emailVerified=false, OTP stored hashed, sendEmailOtp invoked.
// 2) Verify with wrong code increments attempts.
// 3) Verify with correct code marks emailVerified true.
// 4) Login blocked before verification (EMAIL_NOT_VERIFIED).
// 5) Resend always returns ok:true.
// 6) Expired token rejected.

export async function issueEmailVerificationOtp({ user, ip, userAgent, requestId } = {}) {
  if (!user || user.emailVerified) return { ok: true };

  const now = new Date();
  const cooldownMs = getEmailOtpResendCooldownMs();
  const lastSentAt = user.emailVerificationSentAt instanceof Date ? user.emailVerificationSentAt : null;
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < cooldownMs) {
    return { ok: true };
  }

  const ttlMs = getEmailOtpTtlMs();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const meta = normalizeMeta({ ip, userAgent });

  await EmailOtpToken.deleteMany({ userId: user._id, purpose: "email_verify" });

  const code = generateOtpCode();
  const codeHash = hashOtp(code);

  await EmailOtpToken.create({
    userId: user._id,
    emailLower: user.emailLower,
    purpose: "email_verify",
    codeHash,
    createdAt: now,
    expiresAt,
    attempts: 0,
    maxAttempts: 5,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  user.emailVerificationSentAt = now;
  await user.save();

  try {
    await sendEmailOtp({ to: user.emailLower, code, requestId });
  } catch {
    // swallow
  }

  return { ok: true };
}

export async function verifyEmailOtp({ email, code, ip, userAgent }) {
  const { emailLower } = normalizeEmail(email);
  const rawCode = String(code || "").trim();
  const now = new Date();
  const meta = normalizeMeta({ ip, userAgent });

  const user = await User.findOne({ emailLower }).select(
    "emailLower isActive emailVerified emailVerifiedAt tokenVersion",
  );
  if (!user || !user.isActive) {
    throw authError(400, "OTP_INVALID");
  }

  const token = await EmailOtpToken.findOne({
    userId: user._id,
    emailLower,
    purpose: "email_verify",
    consumedAt: null,
    expiresAt: { $gt: now },
  });
  if (!token) throw authError(400, "OTP_INVALID");

  if (Number(token.attempts || 0) >= Number(token.maxAttempts || 5)) {
    throw authError(429, "OTP_TOO_MANY_ATTEMPTS");
  }

  const ok = verifyOtpHash(rawCode, token.codeHash);
  if (!ok) {
    token.attempts = Number(token.attempts || 0) + 1;
    if (token.attempts >= Number(token.maxAttempts || 5)) {
      token.consumedAt = now;
    }
    token.ip = meta.ip;
    token.userAgent = meta.userAgent;
    await token.save();
    throw authError(400, "OTP_INVALID");
  }

  token.consumedAt = now;
  token.ip = meta.ip;
  token.userAgent = meta.userAgent;
  await token.save();

  user.emailVerified = true;
  user.emailVerifiedAt = now;
  user.tokenVersion = Number(user.tokenVersion || 0) + 1;
  if (user.resetLoginAttempts) user.resetLoginAttempts();
  await user.save();

  await RefreshSession.updateMany({ userId: user._id }, { $set: { revokedAt: now } });

  return { user };
}

export async function resendEmailOtp({ email, ip, userAgent, requestId }) {
  const { emailLower } = normalizeEmail(email);
  if (!emailLower) return { ok: true };

  const user = await User.findOne({ emailLower }).select(
    "emailLower isActive emailVerified emailVerificationSentAt",
  );
  if (!user || !user.isActive || user.emailVerified) return { ok: true };

  await issueEmailVerificationOtp({ user, ip, userAgent, requestId });
  return { ok: true };
}
