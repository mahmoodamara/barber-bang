// src/routes/health.routes.js
import express from "express";
import mongoose from "mongoose";
import { getRequestId } from "../middleware/error.js";
import { getDbHealth } from "../config/db.js";

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

/**
 * GET /api/health (root)
 * Simple health check - always returns 200 if the server is running.
 * Use /health/ready for full readiness check including DB.
 */
router.get("/", (_req, res) => {
  return res.json({ ok: true, success: true, data: { status: "healthy" } });
});

router.get("/live", (_req, res) => {
  return res.json({ ok: true, data: {} });
});

/**
 * ✅ DELIVERABLE #1: Readiness endpoint includes DB health + transaction support
 * Returns NOT READY if:
 * - Database not connected
 * - Required env vars missing
 * - Transactions required but not supported
 */
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

  // ✅ Check DB health including transaction support
  const dbHealth = getDbHealth();
  if (!dbHealth.healthy) {
    return res.status(503).json(
      errorPayload(
        req,
        "DB_NOT_HEALTHY",
        dbHealth.transactionsRequired && !dbHealth.transactionsSupported
          ? "Transactions required but not supported. Use a MongoDB replica set."
          : "Database health check failed"
      )
    );
  }

  return res.json({
    ok: true,
    data: {
      dbConnected: dbHealth.connected,
      transactionsSupported: dbHealth.transactionsSupported,
      transactionsRequired: dbHealth.transactionsRequired,
    },
  });
});

export default router;
