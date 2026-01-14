import crypto from "node:crypto";
import { ENV } from "../utils/env.js";

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function requireMetricsAuth(req, res, next) {
  const token = (ENV.METRICS_TOKEN || "").trim();
  if (!token) {
    if (ENV.NODE_ENV === "production" && ENV.METRICS_ENABLED) {
      return res.status(403).send("Forbidden");
    }
    return next();
  }

  const hdr = String(req.headers.authorization || "");
  if (!hdr.startsWith("Bearer ")) return res.status(401).send("Unauthorized");

  const got = hdr.slice("Bearer ".length).trim();
  if (!safeEqual(got, token)) return res.status(401).send("Unauthorized");

  next();
}
