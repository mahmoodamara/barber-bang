/**
 * src/worker/worker.js — Phase 6 hardened (Multi-instance safe)
 *
 * Responsibilities:
 * - Process jobs with lease-based locking + heartbeat lease extension (invoice_email + read_models_refresh + others)
 * - Cancel expired pending_payment orders (SAFE in multi-instance: leader-only scheduler)
 * - Schedule periodic tasks ONLY via leader scheduler (Phase 6 LeaseLock)
 * - Never query Mongo before connection is READY (prevents buffering timeouts)
 * - Graceful shutdown + backoff on transient DB errors
 * - Stronger loop stability: jittered backoff, uncaught handlers
 *
 * Notes:
 * - Job schema assumed: status,name,attempts,runAt,lockedUntil,startedAt,finishedAt,lastError
 * - Optional fields are used safely if present: lockedBy, leaseUpdatedAt
 */

import crypto from "node:crypto";

import { connectDb, disconnectDb, isDbReady } from "../data/db.js";
import { logger } from "../utils/logger.js";
import { ENV } from "../utils/env.js";
import { sleep } from "../utils/sleep.js";

import { Job } from "../models/Job.js";

// business ops
import { cancelExpiredOrders } from "../services/payment.service.js";

// processors
import { process as invoiceProc } from "../jobs/processors/invoiceEmail.processor.js";
import { process as readModelsRefreshProc } from "../jobs/processors/readModelsRefresh.processor.js";
import { process as notificationSendProc } from "../jobs/processors/notificationSend.processor.js";

// Phase 4/5 job enqueue
import { enqueueJob } from "../jobs/jobRunner.js";

// Phase 6: leader scheduler (prevents double scheduling/cancel across instances)
import { startLeaderScheduler } from "./scheduler.js";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const WORKER_ID = String(ENV.INSTANCE_ID || "").trim()
  ? `w_${ENV.INSTANCE_ID}_${process.pid}_${crypto.randomBytes(3).toString("hex")}`
  : `w_${process.pid}_${crypto.randomBytes(3).toString("hex")}`;

const LEASE_MS = Number(ENV.WORKER_LEASE_MS || 90_000);
const LEASE_HEARTBEAT_MS = Math.min(
  30_000,
  Math.max(5_000, Math.floor(LEASE_MS / 3)),
);

const MAX_ATTEMPTS = Number(ENV.WORKER_MAX_ATTEMPTS || 5);

const IDLE_SLEEP_MS = Number(ENV.WORKER_IDLE_SLEEP_MS || 1200);
const LOOP_ERROR_SLEEP_MS = Number(ENV.WORKER_LOOP_ERROR_SLEEP_MS || 2500);

let shuttingDown = false;
let stopScheduler = null;

/* ------------------------------------------------------------------ */
/* Processor registry                                                   */
/* ------------------------------------------------------------------ */

const PROCESSORS = {
  invoice_email: invoiceProc,
  read_models_refresh: readModelsRefreshProc,
  notification_send: notificationSendProc,

  // If you have it from Phase 4:
  // ops_monitor: opsMonitorProc,
};

const PROCESSABLE_NAMES = Object.keys(PROCESSORS);

/* ------------------------------------------------------------------ */
/* Error classification + helpers                                       */
/* ------------------------------------------------------------------ */

function isTransientMongoError(err) {
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  const msg = String(err?.message || "");

  return (
    name.includes("MongoNetworkError") ||
    name.includes("MongoServerSelectionError") ||
    msg.includes("buffering timed out") ||
    msg.includes("Server selection timed out") ||
    msg.includes("Topology is closed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    msg.includes("socket")
  );
}

function jitter(ms, pct = 0.2) {
  const delta = Math.floor(ms * pct);
  const j = Math.floor((Math.random() * 2 - 1) * delta);
  return Math.max(50, ms + j);
}

function backoffMs(attempts) {
  const base = 1200;
  const ms = Math.min(60_000, base * Math.max(1, attempts));
  return jitter(ms, 0.25);
}

async function extendLease(jobId) {
  const now = new Date();
  const lockedUntil = new Date(Date.now() + LEASE_MS);

  await Job.updateOne(
    { _id: jobId, status: "processing" },
    { $set: { lockedUntil, leaseUpdatedAt: now } },
  );
}

/* ------------------------------------------------------------------ */
/* Job picking (atomic claim)                                           */
/* ------------------------------------------------------------------ */

async function pickJob() {
  const now = new Date();
  const lockedUntil = new Date(Date.now() + LEASE_MS);

  return Job.findOneAndUpdate(
    {
      status: "pending",
      name: { $in: PROCESSABLE_NAMES },
      attempts: { $lt: MAX_ATTEMPTS },
      runAt: { $lte: now }, // If runAt doesn't exist in schema, remove this line
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        status: "processing",
        lockedUntil,
        startedAt: now,
        lockedBy: WORKER_ID, // ignored if not in schema (safe)
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { runAt: 1, createdAt: 1 } },
  );
}

/* ------------------------------------------------------------------ */
/* Run one job with lease heartbeat                                     */
/* ------------------------------------------------------------------ */

async function runOnce(job) {
  const processor = PROCESSORS[job.name];

  if (!processor) {
    job.status = "failed";
    job.finishedAt = new Date();
    job.lockedUntil = null;
    job.lastError = `unknown_processor:${job.name}`;
    await job.save();
    return;
  }

  let hb = null;

  try {
    hb = setInterval(() => {
      extendLease(job._id).catch(() => {});
    }, LEASE_HEARTBEAT_MS).unref();

    await processor(job);

    job.status = "succeeded";
    job.finishedAt = new Date();
    job.lockedUntil = null;
    job.lastError = null;
    await job.save();
  } catch (e) {
    const attempts = Number(job.attempts || 1);
    const errMsg = String(e?.message || e);

    job.lastError = errMsg;
    job.lockedUntil = null;

    if (attempts >= MAX_ATTEMPTS) {
      job.status = "failed";
      job.finishedAt = new Date();
    } else {
      job.status = "pending";
      const delayMs = backoffMs(attempts);
      if ("runAt" in job) job.runAt = new Date(Date.now() + delayMs);
    }

    await job.save();
  } finally {
    if (hb) clearInterval(hb);
  }
}

/* ------------------------------------------------------------------ */
/* Leader-only periodic work (Phase 6)                                  */
/* ------------------------------------------------------------------ */

function startPhase6LeaderWork() {
  // Leader scheduler will:
  // - enqueue read_models_refresh periodically (deduped)
  // - execute cancelExpiredOrders leader-only safely
  // This prevents duplicated periodic work across instances.
  stopScheduler = startLeaderScheduler({ isDbReadyFn: isDbReady });
}

/* ------------------------------------------------------------------ */
/* Main worker loop                                                     */
/* ------------------------------------------------------------------ */

export async function runJobs() {
  logger.info(
    { workerId: WORKER_ID, processors: PROCESSABLE_NAMES },
    "[worker] started",
  );

  // Phase 6: schedule periodic tasks only on leader
  startPhase6LeaderWork();

  while (!shuttingDown) {
    try {
      if (!isDbReady()) {
        logger.warn("[worker] DB not ready; waiting...");
        await sleep(1000);
        continue;
      }

      const job = await pickJob();

      if (!job) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      await runOnce(job);
    } catch (e) {
      if (isTransientMongoError(e)) {
        logger.warn({ err: e }, "[worker] transient mongo error; backing off");
        await sleep(jitter(1500, 0.3));
        continue;
      }

      logger.error({ err: e }, "[WORKER_LOOP_ERROR]");
      await sleep(LOOP_ERROR_SLEEP_MS);
    }
  }

  logger.info("[worker] stopped gracefully");
}

/* ------------------------------------------------------------------ */
/* Graceful shutdown                                                    */
/* ------------------------------------------------------------------ */

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "[worker] received shutdown signal");

  try {
    // Stop leader scheduler first (prevents new scheduled actions)
    try {
      stopScheduler?.();
    } catch {
      // ignore
    }

    // Let loop exit naturally
    await sleep(250);

    // Best-effort: release leases held by this worker (if schema supports lockedBy)
    try {
      await Job.updateMany(
        { status: "processing", lockedBy: WORKER_ID },
        { $set: { status: "pending", lockedUntil: null } },
      );
    } catch {
      // ignore
    }

    await disconnectDb();
  } catch (e) {
    logger.warn({ err: e }, "[worker] shutdown disconnectDb failed");
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "[worker] unhandledRejection");
  shutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "[worker] uncaughtException");
  shutdown("uncaughtException");
});

/* ------------------------------------------------------------------ */
/* Bootstrap                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  await connectDb(); // critical: wait until MongoDB is connected

  // Optional: seed leader-only job definitions if needed (no-op here)
  // Example: enqueue an ops_monitor job on startup leader-only:
  // (This should be done in scheduler.js instead.)

  await runJobs();
}

// ---- ENTRYPOINT ----
bootstrap().catch((e) => {
  logger.error({ err: e }, "[worker] bootstrap failed");
  process.exit(1);
});
