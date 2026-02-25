import "dotenv/config";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Optional Sentry (early init, no PII; requestId added in error handler)
if (process.env.SENTRY_DSN) {
  try {
    const Sentry = require("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || "development",
      beforeSend(event) {
        // Strip PII from event; requestId is set in error handler extra
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });
  } catch (e) {
    // Sentry optional
  }
}

// Optional OpenTelemetry (must run before app so instrumentations patch http/express)
import "./tracing.js";

import http from "node:http";
import mongoose from "mongoose";

import { app } from "./app.js";
import { connectDB } from "./config/db.js";
import { log } from "./utils/logger.js";
import { initRateLimiters } from "./middleware/rateLimit.js";
import { initRedisCache } from "./utils/cache.js";
import {
  startReservationRepairJob,
  stopReservationRepairJob,
} from "./jobs/reservationsRepair.job.js";
import {
  startProductRankingJob,
  stopProductRankingJob,
} from "./jobs/productRanking.job.js";
import {
  startInvoiceRetryJob,
  stopInvoiceRetryJob,
} from "./jobs/invoiceRetry.job.js";

/* ============================
   Env + Config
============================ */
const PORT = Number(process.env.PORT || 4000);
const HOST = String(process.env.HOST || "0.0.0.0");

const ENABLE_REPAIR_JOB =
  String(process.env.ENABLE_RESERVATION_REPAIR_JOB || "true")
    .trim()
    .toLowerCase() !== "false";

const REPAIR_INTERVAL_MS =
  Number(process.env.RESERVATION_REPAIR_INTERVAL_MS) || 3 * 60 * 1000;

const ENABLE_RANKING_JOB =
  String(process.env.ENABLE_RANKING_JOB || "true")
    .trim()
    .toLowerCase() !== "false";

const PRODUCT_RANKING_INTERVAL_MS =
  Number(process.env.PRODUCT_RANKING_INTERVAL_MS) || 600000;

const ENABLE_INVOICE_RETRY_JOB =
  String(process.env.ENABLE_INVOICE_RETRY_JOB || "true")
    .trim()
    .toLowerCase() !== "false";
const INVOICE_RETRY_INTERVAL_MS =
  Number(process.env.INVOICE_RETRY_INTERVAL_MS) || 5 * 60 * 1000; // 5 minutes

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

/**
 * ✅ HTTP Hardening (against slowloris / stuck connections)
 */
const REQUEST_TIMEOUT_MS =
  Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 30_000;

const HEADERS_TIMEOUT_MS =
  Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 10_000;

const KEEP_ALIVE_TIMEOUT_MS =
  Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS) || 65_000;

if (!Number.isFinite(PORT) || PORT <= 0) {
  log.error({ phase: "server", port: process.env.PORT }, "Invalid PORT value");
  process.exit(1);
}

/* ============================
   Readiness flag (health)
============================ */
let isReady = false;

/**
 * ✅ Add lightweight readiness endpoint without breaking your routing:
 * You can keep it here, or move it to app.js if you prefer.
 */
app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    success: true,
    data: {
      status: "ok",
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      ready: isReady,
    },
  });
});

app.get("/readyz", (req, res) => {
  // readiness = DB connection OK + server boot completed
  const dbOk = mongoose.connection?.readyState === 1;
  const ready = Boolean(isReady && dbOk);

  res.status(ready ? 200 : 503).json({
    ok: ready,
    success: ready,
    data: {
      ready,
      db: dbOk ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
    },
  });
});

/* ============================
   Bootstrap
============================ */
async function bootstrap() {
  // 0) Validate critical payment env vars at startup
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    log.warn(
      { phase: "server" },
      "STRIPE_WEBHOOK_SECRET is not set — Stripe webhooks will fail. Set it before going live.",
    );
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    log.warn(
      { phase: "server" },
      "STRIPE_SECRET_KEY is not set — Stripe payments will fail.",
    );
  }

  // 1) DB
  await connectDB();

  // 2) Rate limiters (Redis optional)
  await initRateLimiters().catch((err) => {
    log.warn(
      { phase: "server", err: String(err?.message || err) },
      "Rate limit Redis init failed (using memory store)",
    );
  });

  // 2.5) Cache (Redis optional)
  await initRedisCache().catch((err) => {
    log.warn(
      { phase: "server", err: String(err?.message || err) },
      "Cache Redis init failed (using memory cache)",
    );
  });

  // 3) Start jobs (only after DB is ready)
  if (ENABLE_REPAIR_JOB) {
    try {
      startReservationRepairJob({ intervalMs: REPAIR_INTERVAL_MS });
      log.info(
        { phase: "server", intervalMs: REPAIR_INTERVAL_MS },
        "Reservation repair job started",
      );
    } catch (err) {
      log.error(
        { phase: "server", err: String(err?.message || err) },
        "Failed to start reservation repair job",
      );
    }
  }

  if (ENABLE_RANKING_JOB) {
    try {
      startProductRankingJob({ intervalMs: PRODUCT_RANKING_INTERVAL_MS });
      log.info(
        { phase: "server", intervalMs: PRODUCT_RANKING_INTERVAL_MS },
        "Product ranking job started",
      );
    } catch (err) {
      log.error(
        { phase: "server", err: String(err?.message || err) },
        "Failed to start product ranking job",
      );
    }
  }

  if (ENABLE_INVOICE_RETRY_JOB) {
    try {
      startInvoiceRetryJob({ intervalMs: INVOICE_RETRY_INTERVAL_MS });
      log.info(
        { phase: "server", intervalMs: INVOICE_RETRY_INTERVAL_MS },
        "Invoice retry job started",
      );
    } catch (err) {
      log.error(
        { phase: "server", err: String(err?.message || err) },
        "Failed to start invoice retry job",
      );
    }
  }

  // 4) Start HTTP server
  const server = http.createServer(app);

  // ✅ Safe timeouts
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  // ✅ Track open sockets for graceful draining
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(PORT, HOST, () => {
    isReady = true;
    log.info({ phase: "server", host: HOST, port: PORT }, "Server running");
  });

  /* ============================
     Server Error Handling
  ============================ */
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      log.error({ phase: "server", port: PORT }, "Port already in use");
      process.exit(1);
    }

    if (err?.code === "EACCES") {
      log.error(
        { phase: "server", port: PORT },
        "No permission to bind to port",
      );
      process.exit(1);
    }

    log.error(
      { phase: "server", err: String(err?.message || err) },
      "Server failed to start",
    );
    process.exit(1);
  });

  /* ============================
     Graceful Shutdown
  ============================ */
  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info({ phase: "server", signal }, "Shutting down gracefully");

    // stop jobs first (no new work)
    try {
      stopReservationRepairJob();
    } catch (e) {
      log.warn(
        { phase: "server", err: String(e?.message || e) },
        "stopReservationRepairJob failed",
      );
    }

    try {
      stopProductRankingJob();
    } catch (e) {
      log.warn(
        { phase: "server", err: String(e?.message || e) },
        "stopProductRankingJob failed",
      );
    }

    try {
      stopInvoiceRetryJob();
    } catch (e) {
      log.warn(
        { phase: "server", err: String(e?.message || e) },
        "stopInvoiceRetryJob failed",
      );
    }

    // stop accepting new connections
    server.close(async (closeErr) => {
      if (closeErr) {
        log.error(
          { phase: "server", err: String(closeErr?.message || closeErr) },
          "Error closing HTTP server",
        );
      } else {
        log.info({ phase: "server" }, "HTTP server closed");
      }

      try {
        await mongoose.disconnect();
        log.info({ phase: "server" }, "MongoDB disconnected");
        process.exit(closeErr ? 1 : 0);
      } catch (err) {
        log.error(
          { phase: "server", err: String(err?.message || err) },
          "Error during MongoDB disconnect",
        );
        process.exit(1);
      }
    });

    // ✅ drain keep-alive sockets (critical for fast shutdown on prod)
    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    }, 1_000).unref();

    // hard-exit fallback (prevents hanging)
    setTimeout(() => {
      log.error({ phase: "server" }, "Force exit (shutdown timeout)");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  /* ============================
     Process-level safety
  ============================ */
  process.on("unhandledRejection", (reason) => {
    log.error(
      { phase: "server", reason: String(reason) },
      "Unhandled Rejection",
    );
    gracefulShutdown("unhandledRejection");
  });

  process.on("uncaughtException", (err) => {
    log.error(
      { phase: "server", err: String(err?.message || err) },
      "Uncaught Exception",
    );
    gracefulShutdown("uncaughtException");
  });
}

bootstrap().catch((err) => {
  log.error(
    { phase: "server", err: String(err?.message || err) },
    "Bootstrap failed",
  );
  process.exit(1);
});
