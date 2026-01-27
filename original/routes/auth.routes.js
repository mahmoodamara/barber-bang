import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { User } from "../models/User.js";
import { signToken } from "../utils/jwt.js";

const router = express.Router();

const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(60),
    email: z.string().email(),
    password: z.string().min(6).max(128),
  }),
});

router.post("/register", validate(registerSchema), async (req, res) => {
  const { name, email, password } = req.validated.body;

  const exists = await User.findOne({ email: email.toLowerCase().trim() });
  if (exists) {
    return res.status(409).json({
      ok: false,
      error: { code: "EMAIL_EXISTS", message: "Email already used" },
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email: email.toLowerCase().trim(),
    passwordHash,
    role: "user",
  });

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  return res.json({
    ok: true,
    data: {
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    },
  });
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6).max(128),
  }),
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const { email, password } = req.validated.body;

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email/password" },
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({
      ok: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email/password" },
    });
  }

  const token = signToken({
    sub: user._id.toString(),
    userId: user._id.toString(),
    role: user.role,
    tokenVersion: user.tokenVersion || 0,
  });

  return res.json({
    ok: true,
    data: {
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    },
  });
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(6).max(128),
    newPassword: z.string().min(6).max(128),
  }),
});

router.post("/change-password", requireAuth(), validate(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.validated.body;

  const user = await User.findById(req.user._id).select("_id passwordHash tokenVersion");
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "User not found" },
    });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    return res.status(401).json({
      ok: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email/password" },
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } }
  );

  return res.json({ ok: true });
});

router.post("/logout", requireAuth(), async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
  return res.json({ ok: true });
});

export default router;
