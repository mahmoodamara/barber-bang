import { isEnabled } from "../services/featureFlags.service.js";

export function featureFlags(req, _res, next) {
  const ctx = { userId: req.auth?.userId || null, role: req.auth?.role || "user" };
  const memo = new Map();

  req.isFlagEnabled = async (key) => {
    if (memo.has(key)) return memo.get(key);
    const v = await isEnabled(key, ctx);
    memo.set(key, v);
    return v;
  };

  next();
}
