// src/services/readModels.service.js (or wherever you keep it)
import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { Job } from "../models/Job.js";
import { ReadModel } from "../models/ReadModel.js";
// import { toMajorUnits } from "../utils/money.js"; // optional if you want to expose major units

const DEFAULT_MAX_TIME_MS = 4000;

// A single "lock key" for refresh jobs
const LOCK_KEY = "readModels:refresh_lock";
const LOCK_TTL_MS = 60_000;

function safeNow() {
  return new Date();
}

function bytesOf(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj ?? {}), "utf8");
  } catch {
    return 0;
  }
}

/**
 * Acquire a Mongo-based lock using ReadModel doc itself.
 * This avoids introducing a new collection.
 */
async function acquireLock({ now, ttlMs }) {
  const expiresAt = new Date(now.getTime() + ttlMs);

  const out = await ReadModel.findOneAndUpdate(
    {
      key: LOCK_KEY,
      $or: [
        { "payload.expiresAt": { $exists: false } },
        { "payload.expiresAt": null },
        { "payload.expiresAt": { $lte: now } },
      ],
    },
    {
      $set: {
        key: LOCK_KEY,
        type: "lock",
        status: "building",
        payload: { expiresAt, acquiredAt: now },
        generatedAt: now,
      },
    },
    { new: true, upsert: true },
  ).lean();

  // If we got the lock, payload.expiresAt will be > now
  if (!out?.payload?.expiresAt) return { ok: false };
  const ok = new Date(out.payload.expiresAt).getTime() > now.getTime();
  return { ok };
}

async function releaseLock({ now }) {
  // Best-effort release
  await ReadModel.updateOne(
    { key: LOCK_KEY },
    { $set: { status: "ready", "payload.expiresAt": new Date(now.getTime() - 1000) } },
  ).catch(() => {});
}

async function upsertReadModel(key, { type, payload, generatedAt, status = "ready", rowCount = 0, lastError = null }) {
  const payloadSizeBytes = bytesOf(payload);

  await ReadModel.updateOne(
    { key },
    {
      $set: {
        key,
        type,
        payload,
        generatedAt,
        status,
        rowCount,
        payloadSizeBytes,
        ...(lastError ? { lastError } : { lastError: { message: "", code: "", at: null } }),
      },
    },
    { upsert: true },
  );
}

/**
 * The main refresh.
 * - Uses a lock to prevent concurrent runs.
 * - Writes metadata: status, rowCount, payloadSizeBytes, lastError.
 * - Keeps payloads small and predictable.
 */
export async function refreshReadModels({ maxTimeMs = DEFAULT_MAX_TIME_MS, force = false } = {}) {
  const now = safeNow();
  const since24h = new Date(now.getTime() - 24 * 60 * 60_000);

  // Optional "force" bypasses lock only if you explicitly want it.
  if (!force) {
    const lock = await acquireLock({ now, ttlMs: LOCK_TTL_MS });
    if (!lock.ok) {
      return { ok: false, code: "READ_MODELS_REFRESH_IN_PROGRESS", generatedAt: now };
    }
  }

  try {
    // Agg pipelines
    const [ordersByStatus, revenue24h, pendingJobs, failedJobs] = await Promise.all([
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
        .option({ maxTimeMS: maxTimeMs })
        .allowDiskUse(true),

      Order.aggregate([
        {
          $match: {
            status: { $in: ["stock_confirmed", "paid", "fulfilled", "partially_refunded", "refunded"] },
            "payment.paidAt": { $gte: since24h },
          },
        },
        {
          $group: {
            _id: null,
            revenueMinor: { $sum: "$pricing.grandTotal" }, // assume minor units stored
            count: { $sum: 1 },
          },
        },
      ])
        .option({ maxTimeMS: maxTimeMs })
        .allowDiskUse(true),

      Job.aggregate([{ $match: { status: "pending" } }, { $group: { _id: "$name", count: { $sum: 1 } } }])
        .option({ maxTimeMS: maxTimeMs })
        .allowDiskUse(true),

      Job.aggregate([{ $match: { status: "failed" } }, { $group: { _id: "$name", count: { $sum: 1 } } }])
        .option({ maxTimeMS: maxTimeMs })
        .allowDiskUse(true),
    ]);

    const revenueDoc = revenue24h?.[0] || { revenueMinor: 0, count: 0 };

    await Promise.all([
      upsertReadModel("orders:status_counts", {
        type: "orders",
        payload: { items: ordersByStatus },
        generatedAt: now,
        rowCount: ordersByStatus.length,
      }),

      upsertReadModel("orders:revenue_24h", {
        type: "orders",
        payload: {
          revenueMinor: Number(revenueDoc.revenueMinor || 0),
          count: Number(revenueDoc.count || 0),
          since: since24h.toISOString(),
          until: now.toISOString(),
        },
        generatedAt: now,
        rowCount: Number(revenueDoc.count || 0),
      }),

      upsertReadModel("jobs:pending_counts", {
        type: "jobs",
        payload: { items: pendingJobs },
        generatedAt: now,
        rowCount: pendingJobs.length,
      }),

      upsertReadModel("jobs:failed_counts", {
        type: "jobs",
        payload: { items: failedJobs },
        generatedAt: now,
        rowCount: failedJobs.length,
      }),
    ]);

    return { ok: true, generatedAt: now };
  } catch (e) {
    const errCode = e?.code || "READ_MODELS_REFRESH_FAILED";
    const message = e?.message || "Read models refresh failed";

    // Store failure on a dedicated status doc (optional but very useful)
    await upsertReadModel("readModels:last_refresh", {
      type: "ops",
      payload: { ok: false, at: now.toISOString() },
      generatedAt: now,
      status: "failed",
      lastError: { message, code: String(errCode), at: now },
    }).catch(() => {});

    throw e;
  } finally {
    if (!force) await releaseLock({ now });
  }
}

export async function getReadModel(key) {
  return ReadModel.findOne({ key }).lean();
}

/**
 * List should NOT return payload by default (admin list performance).
 */
export async function listReadModels({ includePayload = false } = {}) {
  const projection = includePayload ? {} : { payload: 0 };
  return ReadModel.find({ key: { $ne: LOCK_KEY } })
    .select(projection)
    .sort({ key: 1 })
    .lean();
}
