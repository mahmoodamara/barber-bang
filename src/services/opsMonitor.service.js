import { Job } from "../models/Job.js";
import { Order } from "../models/Order.js";
import { StripeEvent } from "../models/StripeEvent.js";
import { sendAlertOnce } from "./alert.service.js";
import { ENV } from "../utils/env.js";

function mins(n) {
  return Math.max(1, Number(n || 5));
}

export async function runOpsMonitors() {
  await Promise.all([
    monitorFailedJobs(),
    monitorStuckProcessingJobs(),
    monitorUnprocessedStripeEvents(),
    monitorExpiredPendingOrders(),
  ]);
}

async function monitorFailedJobs() {
  const windowMins = mins(ENV.OPS_FAILED_JOBS_WINDOW_MINUTES || 15);
  const threshold = Number(ENV.OPS_FAILED_JOBS_THRESHOLD || 5);

  const since = new Date(Date.now() - windowMins * 60_000);
  const count = await Job.countDocuments({ status: "failed", updatedAt: { $gte: since } });

  if (count >= threshold) {
    await sendAlertOnce({
      key: `failed_jobs:${windowMins}m`,
      subject: `OPS Alert: failed jobs spike (${count} in ${windowMins}m)`,
      text: `There are ${count} failed jobs in the last ${windowMins} minutes.`,
      meta: { count, windowMins },
    });
  }
}

async function monitorStuckProcessingJobs() {
  const stuckMins = mins(ENV.OPS_STUCK_JOB_MINUTES || 10);
  const olderThan = new Date(Date.now() - stuckMins * 60_000);

  const count = await Job.countDocuments({
    status: "processing",
    lockedUntil: { $lt: new Date() }, // lease expired
    updatedAt: { $lt: olderThan },
  });

  if (count > 0) {
    await sendAlertOnce({
      key: `stuck_jobs:${stuckMins}m`,
      subject: `OPS Alert: stuck jobs (${count})`,
      text: `There are ${count} jobs stuck in processing beyond ${stuckMins} minutes.`,
      meta: { count, stuckMins },
    });
  }
}

async function monitorUnprocessedStripeEvents() {
  const minsThreshold = mins(ENV.OPS_UNPROCESSED_STRIPE_EVENTS_MINUTES || 5);
  const olderThan = new Date(Date.now() - minsThreshold * 60_000);

  const count = await StripeEvent.countDocuments({
    status: { $in: ["received", "new"] },
    createdAt: { $lt: olderThan },
  });

  if (count > 0) {
    await sendAlertOnce({
      key: `stripe_events_unprocessed:${minsThreshold}m`,
      subject: `OPS Alert: unprocessed Stripe events (${count})`,
      text: `There are ${count} Stripe events still unprocessed older than ${minsThreshold} minutes.`,
      meta: { count, minsThreshold },
    });
  }
}

async function monitorExpiredPendingOrders() {
  const graceMins = 10;
  const olderThan = new Date(Date.now() - graceMins * 60_000);

  const count = await Order.countDocuments({
    status: "pending_payment",
    expiresAt: { $lt: olderThan },
  });

  if (count > 0) {
    await sendAlertOnce({
      key: `expired_pending_orders`,
      subject: `OPS Alert: expired pending orders (${count})`,
      text: `There are ${count} pending_payment orders expired (expiresAt + ${graceMins}m).`,
      meta: { count, graceMins },
    });
  }
}
