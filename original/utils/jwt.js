import jwt from "jsonwebtoken";

export function signToken(payload) {
  const normalized = { ...(payload || {}) };
  if (!normalized.sub && normalized.userId) normalized.sub = normalized.userId;

  return jwt.sign(normalized, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}
