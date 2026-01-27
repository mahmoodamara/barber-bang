import { verifyToken } from "../utils/jwt.js";
import { User } from "../models/User.js";

export function requireAuth() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) {
        return res.status(401).json({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Missing token" },
        });
      }

      const payload = verifyToken(token);
      const userId = payload.userId || payload.sub;
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid token" },
        });
      }

      const user = await User.findById(userId).select("_id name email role tokenVersion");

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "User not found" },
        });
      }

      if (Number(payload?.tokenVersion || 0) !== Number(user?.tokenVersion || 0)) {
        return res.status(401).json({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid token" },
        });
      }

      req.user = user;
      next();
    } catch {
      return res.status(401).json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Invalid token" },
      });
    }
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Not authenticated" },
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        error: { code: "FORBIDDEN", message: "Access denied" },
      });
    }

    next();
  };
}
