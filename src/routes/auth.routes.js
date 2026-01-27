import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { getRequestId } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { User } from "../models/User.js";
import { signToken, signRefreshToken, verifyToken } from "../utils/jwt.js";

const router = express.Router();

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

router.post("/register", validate(registerSchema), async (req, res) => {
  const startAt = Date.now();
  const { name, email, password } = req.validated.body;

  const safeEmail = normalizeEmail(email);

  const exists = await User.findOne({ email: safeEmail }).select("_id");
  if (exists) {
    // Prevent account enumeration: return generic success
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

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(), // backward compatible
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  const minDelayMs = Number(process.env.REGISTER_MIN_DELAY_MS || 200);
  const elapsed = Date.now() - startAt;
  if (elapsed < minDelayMs) {
    await new Promise((r) => setTimeout(r, minDelayMs - elapsed));
  }

  return res.json(
    okPayload({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    })
  );
});

// Login keeps min(1) to not break existing users with old passwords
const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1).max(128),
  }),
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.validated.body;

  const safeEmail = normalizeEmail(email);

  const user = await User.findOne({ email: safeEmail }).select(
    "_id name email role tokenVersion isBlocked passwordHash"
  );

  // Do not reveal whether user exists
  if (!user) {
    return res.status(401).json(errorPayload(req, "INVALID_CREDENTIALS", "Invalid email/password"));
  }

  // Blocked user check
  if (user.isBlocked) {
    return res.status(403).json(errorPayload(req, "USER_BLOCKED", "Your account has been blocked"));
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json(errorPayload(req, "INVALID_CREDENTIALS", "Invalid email/password"));
  }

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(), // backward compatible
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  return res.json(
    okPayload({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
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

router.post("/logout", requireAuth(), async (req, res) => {
  // Revoke existing tokens by bumping tokenVersion
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  return res.json(okPayload({}));
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
});

router.post("/refresh", validate(refreshSchema), async (req, res) => {
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
