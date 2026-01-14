import cors from "cors";
import { ENV } from "../utils/env.js";

export function corsMiddleware() {
  const allowList = new Set(ENV.CORS_ORIGINS);

  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowList.has(origin)) return cb(null, true);

      const err = new Error("CORS_NOT_ALLOWED");
      err.statusCode = 403;
      return cb(err, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id",
      "Accept-Language",
      "Idempotency-Key",
      "X-Idempotency-Key",
      "x-idempotency-key",
    ],
    maxAge: 86400,
  });
}
