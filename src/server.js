import "dotenv/config";
import http from "node:http";
import mongoose from "mongoose";

import { app } from "./app.js";
import { connectDB } from "./config/db.js";
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

const SHUTDOWN_TIMEOUT_MS =
  Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

/**
 * ✅ HTTP Hardening (against slowloris / stuck connections)
 */
const REQUEST_TIMEOUT_MS =
  Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 30_000;

const HEADERS_TIMEOUT_MS =
  Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 10_000;

const KEEP_ALIVE_TIMEOUT_MS =
  Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS) || 65_000;

const SERVER_LOG_PREFIX = "[server]";

if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error(`${SERVER_LOG_PREFIX} Invalid PORT value: ${process.env.PORT}`);
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
  // 1) DB
  await connectDB();

  // 2) Rate limiters (Redis optional)
  await initRateLimiters().catch((err) => {
    console.warn(
      `${SERVER_LOG_PREFIX} Rate limit Redis init failed (using memory store):`,
      String(err?.message || err)
    );
  });

  // 2.5) Cache (Redis optional)
  await initRedisCache().catch((err) => {
    console.warn(
      `${SERVER_LOG_PREFIX} Cache Redis init failed (using memory cache):`,
      String(err?.message || err)
    );
  });

  // 3) Start jobs (only after DB is ready)
  if (ENABLE_REPAIR_JOB) {
    try {
      startReservationRepairJob({ intervalMs: REPAIR_INTERVAL_MS });
      console.log(
        `${SERVER_LOG_PREFIX} Reservation repair job started (interval=${REPAIR_INTERVAL_MS}ms)`
      );
    } catch (err) {
      console.error(
        `${SERVER_LOG_PREFIX} Failed to start reservation repair job:`,
        String(err?.message || err)
      );
    }
  }

  if (ENABLE_RANKING_JOB) {
    try {
      startProductRankingJob({ intervalMs: PRODUCT_RANKING_INTERVAL_MS });
      console.log(
        `${SERVER_LOG_PREFIX} Product ranking job started (interval=${PRODUCT_RANKING_INTERVAL_MS}ms)`
      );
    } catch (err) {
      console.error(
        `${SERVER_LOG_PREFIX} Failed to start product ranking job:`,
        String(err?.message || err)
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
    console.log(`${SERVER_LOG_PREFIX} running on http://${HOST}:${PORT}`);
  });

  /* ============================
     Server Error Handling
  ============================ */
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `${SERVER_LOG_PREFIX} Port ${PORT} is already in use. Stop the other process or change PORT in .env`
      );
      process.exit(1);
    }

    if (err?.code === "EACCES") {
      console.error(
        `${SERVER_LOG_PREFIX} No permission to bind to port ${PORT}. Try a higher port (e.g., 4001).`
      );
      process.exit(1);
    }

    console.error(`${SERVER_LOG_PREFIX} Server failed to start:`, err);
    process.exit(1);
  });

  /* ============================
     Graceful Shutdown
  ============================ */
  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`${SERVER_LOG_PREFIX} ${signal} received, shutting down gracefully...`);

    // stop jobs first (no new work)
    try {
      stopReservationRepairJob();
    } catch (e) {
      console.warn(`${SERVER_LOG_PREFIX} stopReservationRepairJob failed:`, String(e?.message || e));
    }

    try {
      stopProductRankingJob();
    } catch (e) {
      console.warn(`${SERVER_LOG_PREFIX} stopProductRankingJob failed:`, String(e?.message || e));
    }

    // stop accepting new connections
    server.close(async (closeErr) => {
      if (closeErr) {
        console.error(`${SERVER_LOG_PREFIX} Error closing HTTP server:`, closeErr);
      } else {
        console.log(`${SERVER_LOG_PREFIX} HTTP server closed`);
      }

      try {
        await mongoose.disconnect();
        console.log(`${SERVER_LOG_PREFIX} MongoDB disconnected`);
        process.exit(closeErr ? 1 : 0);
      } catch (err) {
        console.error(`${SERVER_LOG_PREFIX} Error during MongoDB disconnect:`, err);
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
      console.error(`${SERVER_LOG_PREFIX} Force exit (shutdown timeout)`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  /* ============================
     Process-level safety
  ============================ */
  process.on("unhandledRejection", (reason) => {
    console.error(`${SERVER_LOG_PREFIX} Unhandled Rejection:`, reason);
    gracefulShutdown("unhandledRejection");
  });

  process.on("uncaughtException", (err) => {
    console.error(`${SERVER_LOG_PREFIX} Uncaught Exception:`, err);
    gracefulShutdown("uncaughtException");
  });
}


bootstrap().catch((err) => {
  console.error(`${SERVER_LOG_PREFIX} Bootstrap failed:`, err);
  process.exit(1);
});
