// src/routes/health.routes.js
import express from "express";
import mongoose from "mongoose";

const router = express.Router();

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
  return res.json({ ok: true });
});

router.get("/ready", (_req, res) => {
  const missing = requiredEnvMissing();
  if (!isMongooseConnected()) {
    return res.status(503).json({
      ok: false,
      error: { code: "DB_NOT_READY", message: "Database not connected" },
    });
  }
  if (missing.length) {
    return res.status(503).json({
      ok: false,
      error: { code: "ENV_MISSING", message: `Missing env: ${missing.join(",")}` },
    });
  }
  return res.json({ ok: true });
});

export default router;
