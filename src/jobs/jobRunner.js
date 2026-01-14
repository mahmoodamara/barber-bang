import crypto from "crypto";
import { Job } from "../models/Job.js";

import { process as invoiceEmail } from "./processors/invoiceEmail.processor.js"; // Phase 3 موجود عندك
import { process as opsMonitor } from "./processors/opsMonitor.processor.js";
import { process as orderExpiry } from "./processors/orderExpiry.processor.js";
import { process as readModelsRefresh } from "./processors/readModelsRefresh.processor.js";
import { process as notificationSend } from "./processors/notificationSend.processor.js";

const PROCESSORS = {
  invoice_email: invoiceEmail,
  ops_monitor: opsMonitor,
  order_expiry_sweep: orderExpiry,
  read_models_refresh: readModelsRefresh,
  notification_send: notificationSend,
};

const LEASE_MS = 60_000;

export async function enqueueJob({
  name,
  payload = {},
  dedupeKey = null,
  runAt = new Date(),
  maxAttempts = 8,
}) {
  if (dedupeKey) {
    // singleton upsert: keep it scheduled and pending
    await Job.updateOne(
      { dedupeKey },
      {
        $set: { runAt, status: "pending" },
        $setOnInsert: { name, payload, maxAttempts, attempts: 0 },
      },
      { upsert: true },
    );
    return;
  }

  await Job.create({ name, payload, status: "pending", runAt, maxAttempts });
}

export async function runJobLoop({ runningRef, sleep }) {
  while (runningRef.running) {
    try {
      const now = new Date();
      const lockId = crypto.randomUUID();

      const job = await Job.findOneAndUpdate(
        {
          status: "pending",
          runAt: { $lte: now },
          $expr: { $lt: ["$attempts", "$maxAttempts"] },
          $or: [
            { lockedUntil: null },
            { lockedUntil: { $exists: false } },
            { lockedUntil: { $lte: now } },
          ],
        },
        {
          $set: { status: "processing", lockId, lockedUntil: new Date(Date.now() + LEASE_MS) },
          $inc: { attempts: 1 },
        },
        { new: true, sort: { runAt: 1, createdAt: 1 } },
      );

      if (!job) {
        await sleep(1500);
        continue;
      }

      const fn = PROCESSORS[job.name];
      if (!fn) {
        await Job.updateOne(
          { _id: job._id, lockId },
          {
            $set: {
              status: "failed",
              lastError: `NO_PROCESSOR:${job.name}`,
              finishedAt: new Date(),
              lockedUntil: null,
            },
          },
        );
        continue;
      }

      try {
        await fn(job);

        await Job.updateOne(
          { _id: job._id, lockId },
          { $set: { status: "succeeded", finishedAt: new Date(), lockedUntil: null } },
        );
      } catch (e) {
        const errMsg = String(e?.message || "JOB_FAILED");
        const attempts = job.attempts || 1;

        if (attempts >= (job.maxAttempts || 8)) {
          await Job.updateOne(
            { _id: job._id, lockId },
            {
              $set: {
                status: "failed",
                lastError: errMsg,
                finishedAt: new Date(),
                lockedUntil: null,
              },
            },
          );
        } else {
          const delayMs = Math.min(60_000, 2000 * attempts);
          await Job.updateOne(
            { _id: job._id, lockId },
            {
              $set: {
                status: "pending",
                lastError: errMsg,
                runAt: new Date(Date.now() + delayMs),
                lockedUntil: null,
              },
            },
          );
        }
      }
    } catch {
      await sleep(2000);
    }
  }
}
