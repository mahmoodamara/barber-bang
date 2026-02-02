// src/jobs/invoiceRetry.job.js
// Background job to retry failed or stuck "issuing" invoices. Safe under concurrency (atomic lock).

import { Order } from "../models/Order.js";
import { retryInvoiceForOrder } from "../services/invoice.service.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INVOICE_ISSUING_STUCK_MIN = Number(process.env.INVOICE_ISSUING_STUCK_MIN) || 15;
const BATCH_SIZE = Number(process.env.INVOICE_RETRY_BATCH) || 25;

let intervalId = null;
let isRunning = false;
let lastRunAt = null;
let lastRunStats = null;

let metrics = null;
async function getMetrics() {
  if (!metrics) {
    try {
      const { getInvoiceRetryCounters } = await import("../middleware/prometheus.js");
      metrics = getInvoiceRetryCounters();
    } catch {
      metrics = { attempt: () => {}, success: () => {}, failed: () => {} };
    }
  }
  return metrics;
}

async function runInvoiceRetryJob() {
  if (isRunning) return lastRunStats;
  isRunning = true;
  const startTime = Date.now();
  const now = new Date();
  const stuckCutoff = new Date(now.getTime() - INVOICE_ISSUING_STUCK_MIN * 60 * 1000);

  let attemptCount = 0;
  let successCount = 0;
  let failedCount = 0;

  try {
    const cursor = Order.find({
      $or: [
        { "invoice.status": "failed" },
        { "invoice.status": "issuing", "invoice.issuingAt": { $lt: stuckCutoff } },
      ],
    })
      .select("_id")
      .limit(BATCH_SIZE)
      .lean()
      .cursor();

    const m = await getMetrics();
    for await (const doc of cursor) {
      const orderId = doc._id;
      attemptCount++;
      m.attempt();
      try {
        const result = await retryInvoiceForOrder(orderId);
        if (result?.ok && result?.issued) {
          successCount++;
          m.success();
        } else if (result?.ok && result?.alreadyIssued) {
          // no-op
        } else {
          failedCount++;
          m.failed();
        }
      } catch (e) {
        failedCount++;
        m.failed();
      }
    }

    lastRunAt = now;
    lastRunStats = {
      runAt: now.toISOString(),
      durationMs: Date.now() - startTime,
      attemptCount,
      successCount,
      failedCount,
    };
    return lastRunStats;
  } catch (err) {
    lastRunStats = { error: String(err?.message || err) };
    return lastRunStats;
  } finally {
    isRunning = false;
  }
}

export function startInvoiceRetryJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (intervalId) return getInvoiceRetryJobStatus();
  intervalId = setInterval(() => {
    runInvoiceRetryJob().catch(() => {});
  }, intervalMs);
  if (intervalId.unref) intervalId.unref();
  runInvoiceRetryJob().catch(() => {});
  return getInvoiceRetryJobStatus();
}

export function stopInvoiceRetryJob() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function getInvoiceRetryJobStatus() {
  return {
    running: !!intervalId,
    currentlyExecuting: isRunning,
    lastRunAt,
    lastRunStats,
  };
}

export async function triggerInvoiceRetryJob() {
  return runInvoiceRetryJob();
}
