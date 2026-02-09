import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import crypto from "node:crypto";

import { requireAuth } from "../middleware/auth.js";
import { getRequestId } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { limitLogin, limitRegister, limitAuthGeneral, limitForgotPassword } from "../middleware/rateLimit.js";
import { User } from "../models/User.js";
import { PasswordResetToken } from "../models/PasswordResetToken.js";
import { EmailVerificationToken } from "../models/EmailVerificationToken.js";
import { signToken, signRefreshToken, verifyToken } from "../utils/jwt.js";
import { mergeGuestCartIntoUser } from "../services/guestCart.service.js";
import { setPrivateNoStore } from "../utils/response.js";

const router = express.Router();

// ✅ Performance: Auth responses are always private/personalized
router.use((req, res, next) => {
  setPrivateNoStore(res);
  next();
});

function normalizeEmail(email) {
  return String(email || "").toLowerCase().trim();
}

function errorPayload(req, code, message) {
  return {
    ok: false,
    success: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

function okPayload(data = {}) {
  return { ok: true, success: true, data };
}

const LOGIN_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS) || 5);
const LOGIN_LOCKOUT_MINUTES = Math.max(5, Number(process.env.LOGIN_LOCKOUT_MINUTES) || 15);

/**
 * Record failed login attempt; returns { incrementLoginAttempts, isLocked }.
 * Caller should check isLocked and return 423 if true.
 */
async function recordFailedLogin(userId) {
  const user = await User.findById(userId).select("loginAttempts lockoutUntil");
  if (!user) return { incrementLoginAttempts: false, isLocked: false };

  const attempts = (user.loginAttempts || 0) + 1;
  const lockoutUntil =
    attempts >= LOGIN_MAX_ATTEMPTS
      ? new Date(Date.now() + LOGIN_LOCKOUT_MINUTES * 60 * 1000)
      : null;

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        loginAttempts: attempts,
        ...(lockoutUntil ? { lockoutUntil } : {}),
      },
    }
  );

  return {
    incrementLoginAttempts: true,
    isLocked: lockoutUntil !== null,
  };
}

/**
 * Password strength validation:
 * - Minimum 8 characters
 * - At least 1 letter and 1 number
 */
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .refine((val) => /[a-zA-Z]/.test(val) && /[0-9]/.test(val), {
    message: "Password must contain at least 1 letter and 1 number",
  });

const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(60),
    email: z.string().email(),
    password: passwordSchema,
  }),
});

/**
 * POST /register
 * On success: data.token and data.user are set, or data.user is null with data.requiresLogin true.
 * When data.user === null, client must not access data.user (e.g. data.user.name); show generic
 * "Please sign in" and redirect to login.
 */
router.post("/register", limitRegister, validate(registerSchema), async (req, res) => {
  const startAt = Date.now();
  const { name, email, password } = req.validated.body;

  const safeEmail = normalizeEmail(email);

  const exists = await User.findOne({ email: safeEmail }).select("_id");
  if (exists) {
    // Prevent account enumeration: return generic success. Client must not access data.user
    // when data.user === null; use data.requiresLogin to show "Please sign in" and redirect.
    const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
    await bcrypt.hash(password, rounds);

    const minDelayMs = Number(process.env.REGISTER_MIN_DELAY_MS || 200);
    const elapsed = Date.now() - startAt;
    if (elapsed < minDelayMs) {
      await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
    }

    return res.json(
      okPayload({
        token: null,
        user: null,
        requiresLogin: true, // client: do not use user; show "Please sign in" and redirect
      })
    );
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  const passwordHash = await bcrypt.hash(password, rounds);

  const user = await User.create({
    name: String(name).trim(),
    email: safeEmail,
    passwordHash,
    role: "user",
  });

  const tokenPayload = {
    sub: user._id.toString(),
    userId: user._id.toString(), // backward compatible
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  };
  const token = signToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  const minDelayMs = Number(process.env.REGISTER_MIN_DELAY_MS || 200);
  const elapsed = Date.now() - startAt;
  if (elapsed < minDelayMs) {
    await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
  }

  return res.json(
    okPayload({
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    })
  );
});

// Login keeps min(1) to not break existing users with old passwords
const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1).max(128),
    // Guest cart ID to merge into user cart on successful login
    guestCartId: z.string().max(64).optional(),
  }),
});

router.post("/login", limitLogin, validate(loginSchema), async (req, res) => {
  const { email, password, guestCartId } = req.validated.body;

  const safeEmail = normalizeEmail(email);
  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);

  const user = await User.findOne({ email: safeEmail }).select(
    "_id name email role tokenVersion isBlocked passwordHash loginAttempts lockoutUntil"
  );

  // Timing attack mitigation: run bcrypt when user not found so response time is similar
  if (!user) {
    await bcrypt.hash(password, rounds);
    return res.status(401).json(errorPayload(req, "INVALID_CREDENTIALS", "Invalid email/password"));
  }

  // Account lockout check
  if (user.lockoutUntil && new Date(user.lockoutUntil) > new Date()) {
    return res.status(423).json(
      errorPayload(req, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.")
    );
  }

  if (user.isBlocked) {
    return res.status(403).json(errorPayload(req, "USER_BLOCKED", "Your account has been blocked"));
  }

  const ok = await bcrypt.compare(password, user.passwordHash);

  if (!ok) {
    const { incrementLoginAttempts, isLocked } = await recordFailedLogin(user._id);
    if (isLocked) {
      return res.status(423).json(
        errorPayload(req, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.")
      );
    }
    return res.status(401).json(errorPayload(req, "INVALID_CREDENTIALS", "Invalid email/password"));
  }

  // Successful login: clear lockout and attempts
  await User.updateOne(
    { _id: user._id },
    { $set: { loginAttempts: 0, lockoutUntil: null } }
  ).catch(() => {});

  const tokenPayload = {
    sub: user._id.toString(),
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  };
  const token = signToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  let cartMerged = 0;
  if (guestCartId) {
    const mergeResult = await mergeGuestCartIntoUser(user._id, guestCartId);
    cartMerged = mergeResult.merged || 0;
  }

  return res.json(
    okPayload({
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
      ...(cartMerged > 0 ? { cartMerged } : {}),
    })
  );
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  }),
});

router.post(
  "/change-password",
  limitAuthGeneral,
  requireAuth(),
  validate(changePasswordSchema),
  async (req, res) => {
    const { currentPassword, newPassword } = req.validated.body;

    const user = await User.findById(req.user._id).select("_id passwordHash tokenVersion isBlocked");
    if (!user) {
      return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "User not found"));
    }

    if (user.isBlocked) {
      return res.status(403).json(errorPayload(req, "USER_BLOCKED", "Your account has been blocked"));
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      return res.status(401).json(errorPayload(req, "INVALID_CREDENTIALS", "Invalid email/password"));
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
    const passwordHash = await bcrypt.hash(newPassword, rounds);

    // Invalidate ALL existing access tokens by bumping tokenVersion
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash }, $inc: { tokenVersion: 1 } }
    );

    return res.json(okPayload({}));
  }
);

router.post("/logout", limitAuthGeneral, requireAuth(), async (req, res) => {
  // Revoke existing tokens by bumping tokenVersion
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  return res.json(okPayload({}));
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's profile.
 * Protected by JWT - relies on req.user populated by requireAuth middleware.
 * Does NOT re-parse the token; uses req.user directly.
 */
router.get("/me", limitAuthGeneral, requireAuth(), async (req, res) => {
  // req.user is already populated by requireAuth middleware
  // Return safe user data (no passwordHash, no sensitive fields)
  const user = req.user;

  return res.json(
    okPayload({
      id: user._id,
      name: user.name || "",
      email: user.email || "",
      role: user.role || "user",
    })
  );
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }),
});

const PASSWORD_RESET_EXPIRY_MINUTES = Math.max(15, Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES) || 60);

/**
 * POST /auth/forgot-password
 * Always returns success to prevent email enumeration.
 * In production, integrate with your email provider to send the reset link.
 */
router.post("/forgot-password", limitForgotPassword, validate(forgotPasswordSchema), async (req, res) => {
  const { email } = req.validated.body;
  const safeEmail = normalizeEmail(email);

  const user = await User.findOne({ email: safeEmail }).select("_id email");
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);
    await PasswordResetToken.deleteMany({ userId: user._id }).catch(() => {});
    await PasswordResetToken.create({ userId: user._id, token, expiresAt });

    const resetLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || ""}/reset-password?token=${token}`.trim();
    if (process.env.NODE_ENV !== "production" && resetLink) {
      req.log?.info?.({ email: safeEmail, resetLink }, "[auth] Password reset link (dev only)");
    }
    // TODO: Send email with resetLink (e.g. via nodemailer, SendGrid, etc.)
  }

  return res.json(okPayload({ message: "If an account exists, you will receive reset instructions." }));
});

const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1),
    newPassword: passwordSchema,
  }),
});

/**
 * POST /auth/reset-password
 * Resets password using token from forgot-password flow.
 */
router.post("/reset-password", limitAuthGeneral, validate(resetPasswordSchema), async (req, res) => {
  const { token, newPassword } = req.validated.body;

  const record = await PasswordResetToken.findOne({
    token: token.trim(),
    usedAt: null,
  }).populate("userId");

  if (!record || !record.userId) {
    return res.status(400).json(
      errorPayload(req, "INVALID_RESET_TOKEN", "Invalid or expired reset token")
    );
  }

  if (new Date(record.expiresAt) < new Date()) {
    await PasswordResetToken.deleteOne({ _id: record._id }).catch(() => {});
    return res.status(400).json(
      errorPayload(req, "INVALID_RESET_TOKEN", "Invalid or expired reset token")
    );
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  const passwordHash = await bcrypt.hash(newPassword, rounds);

  await User.updateOne(
    { _id: record.userId._id },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } }
  );
  await PasswordResetToken.updateOne(
    { _id: record._id },
    { $set: { usedAt: new Date() } }
  );

  return res.json(okPayload({ message: "Password has been reset. You can now sign in." }));
});

const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(1),
  }),
});

const EMAIL_VERIFICATION_EXPIRY_MINUTES = Math.max(60, Number(process.env.EMAIL_VERIFICATION_EXPIRY_MINUTES) || 24 * 60);

/**
 * POST /auth/verify-email
 * Verifies email using token sent via send-verification-email (or after register if you send it).
 */
router.post("/verify-email", limitAuthGeneral, validate(verifyEmailSchema), async (req, res) => {
  const { token } = req.validated.body;

  const record = await EmailVerificationToken.findOne({
    token: token.trim(),
    usedAt: null,
  }).populate("userId");

  if (!record || !record.userId) {
    return res.status(400).json(
      errorPayload(req, "INVALID_VERIFICATION_TOKEN", "Invalid or expired verification token")
    );
  }

  if (new Date(record.expiresAt) < new Date()) {
    await EmailVerificationToken.deleteOne({ _id: record._id }).catch(() => {});
    return res.status(400).json(
      errorPayload(req, "INVALID_VERIFICATION_TOKEN", "Invalid or expired verification token")
    );
  }

  await User.updateOne({ _id: record.userId._id }, { $set: { isEmailVerified: true } });
  await EmailVerificationToken.updateOne(
    { _id: record._id },
    { $set: { usedAt: new Date() } }
  );

  return res.json(okPayload({ message: "Email verified successfully." }));
});

/**
 * POST /auth/send-verification-email
 * Creates verification token and sends email (or logs link in dev).
 * Requires auth.
 */
router.post("/send-verification-email", limitAuthGeneral, requireAuth(), async (req, res) => {
  const user = await User.findById(req.user._id).select("_id email isEmailVerified");
  if (!user) {
    return res.status(401).json(errorPayload(req, "UNAUTHORIZED", "User not found"));
  }
  if (user.isEmailVerified) {
    return res.json(okPayload({ message: "Email is already verified." }));
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000);
  await EmailVerificationToken.deleteMany({ userId: user._id }).catch(() => {});
  await EmailVerificationToken.create({ userId: user._id, token, expiresAt });

  const verifyLink = `${process.env.FRONTEND_URL || process.env.CLIENT_URL || ""}/verify-email?token=${token}`.trim();
  if (process.env.NODE_ENV !== "production" && verifyLink) {
    req.log?.info?.({ email: user.email, verifyLink }, "[auth] Email verification link (dev only)");
  }
  // TODO: Send email with verifyLink

  return res.json(okPayload({ message: "If not already verified, you will receive a verification email." }));
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
});

router.post("/refresh", limitAuthGeneral, validate(refreshSchema), async (req, res) => {
  const { refreshToken } = req.validated.body;

  try {
    // Verify refresh token
    const decoded = verifyToken(refreshToken);

    // Extract user ID from token
    const userId = decoded.sub || decoded.userId;
    if (!userId) {
      return res.status(401).json(
        errorPayload(req, "INVALID_TOKEN", "Token missing user identifier")
      );
    }

    // Check user exists and is not blocked
    const user = await User.findById(userId).select(
      "_id name email role tokenVersion isBlocked"
    );

    if (!user) {
      return res.status(401).json(
        errorPayload(req, "INVALID_TOKEN", "User not found")
      );
    }

    if (user.isBlocked) {
      return res.status(403).json(
        errorPayload(req, "USER_BLOCKED", "Your account has been blocked")
      );
    }

    // Verify tokenVersion matches (revocation check)
    const tokenVersion = Number(decoded.tokenVersion || 0);
    if (tokenVersion !== user.tokenVersion) {
      return res.status(401).json(
        errorPayload(req, "TOKEN_REVOKED", "Token has been revoked")
      );
    }

    // Generate new tokens
    const tokenPayload = {
      sub: user._id.toString(),
      userId: user._id.toString(),
      role: user.role,
      tokenVersion: user.tokenVersion,
    };

    const accessToken = signToken(tokenPayload);
    const newRefreshToken = signRefreshToken(tokenPayload);

    return res.json(
      okPayload({
        accessToken: accessToken,
        refreshToken: newRefreshToken,
        expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
      })
    );
  } catch (err) {
    // Handle JWT verification errors
    if (err?.code === "TOKEN_INVALID" || err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
      return res.status(401).json(
        errorPayload(req, "INVALID_TOKEN", "Invalid or expired refresh token")
      );
    }

    // Unexpected error
    console.error("[auth] Refresh token error:", err);
    return res.status(500).json(
      errorPayload(req, "INTERNAL_ERROR", "Failed to refresh token")
    );
  }
});

export default router;
