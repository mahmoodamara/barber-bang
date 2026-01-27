// src/routes/health.routes.js
import express from "express";
import mongoose from "mongoose";
import { getRequestId } from "../middleware/error.js";

const router = express.Router();

function errorPayload(req, code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

function requiredEnvMissing() {
  const missing = [];
  if (!process.env.MONGO_URI) missing.push("MONGO_URI");
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  return missing;
}

function isMongooseConnected() {
  return mongoose.connection?.readyState === 1;
}

router.get("/live", (_req, res) => {
  return res.json({ ok: true, data: {} });
});

router.get("/ready", (req, res) => {
  const missing = requiredEnvMissing();
  if (!isMongooseConnected()) {
    return res.status(503).json(errorPayload(req, "DB_NOT_READY", "Database not connected"));
  }
  if (missing.length) {
    return res.status(503).json(
      errorPayload(req, "ENV_MISSING", `Missing env: ${missing.join(",")}`)
    );
  }
  return res.json({ ok: true, data: {} });
});

export default router;
