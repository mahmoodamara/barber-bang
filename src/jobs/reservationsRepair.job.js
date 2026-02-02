// src/jobs/reservationsRepair.job.js
// Background job to repair orphaned/stale stock reservations.
// Safe, idempotent, and production-ready.

import { StockReservation } from "../models/StockReservation.js";
import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { Coupon } from "../models/Coupon.js";
import { CouponReservation } from "../models/CouponReservation.js";
import mongoose from "mongoose";
import { releaseCouponReservation } from "../services/pricing.service.js";
import { releaseStockReservation } from "../services/products.service.js";

// Configuration
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const GRACE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes - don't touch reservations newer than this
const BATCH_LIMIT = 100; // Max reservations to process per run
const EXPIRED_GRACE_MS = 2 * 60 * 1000; // 2 minutes after expiresAt before we force-release
const STRIPE_CHECKOUT_STALE_MIN = Number(process.env.STRIPE_CHECKOUT_STALE_MINUTES) || 15;

// State
let intervalId = null;
let isRunning = false;
let lastRunAt = null;
let lastRunStats = null;

/**
 * Convert variant ID to ObjectId safely
 */
function toVariantObjectId(id) {
  const v = String(id || "").trim();
  if (!v) return null;
  return mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null;
}

/**
 * Restore stock for a list of items (used when releasing orphaned reservations)
 */
async function restoreStockForItems(items) {
  if (!items?.length) return;

  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (qty <= 0) continue;

    const variantObjId = toVariantObjectId(it.variantId);
    const isVariant = Boolean(variantObjId);

    try {
      if (isVariant) {
        await Product.updateOne(
          { _id: it.productId, "variants._id": variantObjId },
          { $inc: { "variants.$.stock": qty } }
        );
      } else {
        await Product.updateOne(
          { _id: it.productId },
          { $inc: { stock: qty } }
        );
      }
    } catch (err) {
      console.warn(`[repair-job] Failed to restore stock for product=${it.productId}:`, String(err?.message || err));
    }
  }
}

/**
 * Repair orphaned reservations (reserved but no matching order exists)
 * This handles crash windows where stock was decremented but order creation failed.
 *
 * Safety guards:
 * - Only process reservations older than GRACE_WINDOW_MS
 * - Only release if order truly doesn't exist
 * - Idempotent: checks status before modifying
 */
async function repairOrphanedReservations(now) {
  const olderThan = new Date(now.getTime() - GRACE_WINDOW_MS);

  const reservations = await StockReservation.find({
    status: "reserved",
    createdAt: { $lt: olderThan },
  })
    .limit(BATCH_LIMIT)
    .lean();

  let repaired = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      // Double-check order existence
      const orderExists = await Order.exists({ _id: r.orderId });

      if (!orderExists) {
        // Atomically update status to released (idempotent)
        const updated = await StockReservation.findOneAndUpdate(
          { _id: r._id, status: "reserved" },
          { $set: { status: "released", expiresAt: now } }
        );

        if (updated) {
          // Restore stock
          await restoreStockForItems(r.items || []);
          console.info(`[repair-job] Released orphaned reservation orderId=${r.orderId}`);
          repaired++;
        }
      }
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { checked: reservations.length, repaired, errors };
}

/**
 * Release expired reservations that MongoDB TTL hasn't cleaned up yet.
 * This handles cases where TTL index is slow or disabled.
 *
 * Safety guards:
 * - Only process reservations expired by more than EXPIRED_GRACE_MS
 * - Idempotent: checks status before modifying
 */
async function releaseExpiredReservations(now) {
  const expiredBefore = new Date(now.getTime() - EXPIRED_GRACE_MS);

  const reservations = await StockReservation.find({
    status: "reserved",
    expiresAt: { $ne: null, $lt: expiredBefore },
  })
    .limit(BATCH_LIMIT)
    .lean();

  let released = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      // Atomically update status to expired
      const updated = await StockReservation.findOneAndUpdate(
        { _id: r._id, status: "reserved" },
        { $set: { status: "expired" } }
      );

      if (updated) {
        // Restore stock
        await restoreStockForItems(r.items || []);
        console.info(`[repair-job] Released expired reservation orderId=${r.orderId}`);
        released++;
      }
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { checked: reservations.length, released, errors };
}

/**
 * Cleanup stale confirmed reservations where order was cancelled/refunded.
 * These don't need stock restoration (already consumed), just status cleanup.
 *
 * Safety guards:
 * - Only mark as released if order is truly cancelled/refunded or missing
 * - Idempotent: checks status before modifying
 */
async function cleanupStaleConfirmedReservations(now) {
  const reservations = await StockReservation.find({
    status: "confirmed",
  })
    .limit(BATCH_LIMIT)
    .lean();

  let cleaned = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      const order = await Order.findById(r.orderId).select("status").lean();

      // Only cleanup if order is missing or in terminal cancelled/refunded state
      if (!order || ["cancelled", "refunded"].includes(order.status)) {
        await StockReservation.updateOne(
          { _id: r._id, status: "confirmed" },
          { $set: { status: "released" } }
        );
        console.info(`[repair-job] Cleaned stale confirmed reservation orderId=${r.orderId}`);
        cleaned++;
      }
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { checked: reservations.length, cleaned, errors };
}

/**
 * Release expired coupon reservations (CouponReservation collection)
 * - Marks reservation as expired
 * - Decrements Coupon.reservedCount
 * - Best-effort updates Order.couponReservation status
 */
async function releaseExpiredCouponReservations(now) {
  const reservations = await CouponReservation.find({
    status: "active",
    expiresAt: { $ne: null, $lt: now },
  })
    .limit(BATCH_LIMIT)
    .lean();

  let expired = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      const updated = await CouponReservation.findOneAndUpdate(
        { _id: r._id, status: "active" },
        { $set: { status: "expired" } }
      );
      if (!updated) continue;

      await Coupon.updateOne(
        { _id: r.couponId, reservedCount: { $gt: 0 } },
        { $inc: { reservedCount: -1 } }
      ).catch(() => {});

      if (r.orderId) {
        await Order.updateOne(
          { _id: r.orderId, "couponReservation.status": "reserved" },
          { $set: { "couponReservation.status": "expired" } }
        ).catch(() => {});
      }

      expired++;
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { checked: reservations.length, expired, errors };
}

/**
 * Cleanup stale Stripe checkout orders missing sessionId
 */
async function cleanupStaleStripeCheckoutOrders(now) {
  if (!Number.isFinite(STRIPE_CHECKOUT_STALE_MIN) || STRIPE_CHECKOUT_STALE_MIN <= 0) {
    return { checked: 0, cleaned: 0, errors: [] };
  }

  const staleBefore = new Date(now.getTime() - STRIPE_CHECKOUT_STALE_MIN * 60 * 1000);
  const orders = await Order.find({
    paymentMethod: "stripe",
    status: "pending_payment",
    createdAt: { $lt: staleBefore },
    $or: [
      { "stripe.sessionId": { $exists: false } },
      { "stripe.sessionId": null },
      { "stripe.sessionId": "" },
    ],
  })
    .limit(BATCH_LIMIT)
    .lean();

  let cleaned = 0;
  const errors = [];

  for (const o of orders) {
    try {
      await releaseStockReservation({ orderId: o._id }).catch(() => {});

      const code = String(
        o?.couponReservation?.code ||
          o?.pricing?.discounts?.coupon?.code ||
          o?.pricing?.couponCode ||
          ""
      ).trim();
      if (code) {
        await releaseCouponReservation({ code, orderId: o._id }).catch(() => {});
      }

      await Order.updateOne(
        { _id: o._id, status: "pending_payment" },
        {
          $set: {
            status: "cancelled",
            internalNote: "Checkout session missing; auto-cancelled",
            ...(code ? { "couponReservation.status": "released" } : {}),
          },
        }
      );

      cleaned++;
    } catch (err) {
      errors.push(`orderId=${o._id}: ${String(err?.message || err)}`);
    }
  }

  return { checked: orders.length, cleaned, errors };
}

/**
 * Main repair job runner
 * Executes all repair operations with safety guards.
 */
async function runRepairJob() {
  if (isRunning) {
    console.info("[repair-job] Skipping - previous run still in progress");
    return null;
  }

  isRunning = true;
  const startTime = Date.now();
  const now = new Date();

  try {
    console.info("[repair-job] Starting reservation repair job...");

    const [orphaned, expired, stale, couponExpired, checkoutStale] = await Promise.all([
      repairOrphanedReservations(now),
      releaseExpiredReservations(now),
      cleanupStaleConfirmedReservations(now),
      releaseExpiredCouponReservations(now),
      cleanupStaleStripeCheckoutOrders(now),
    ]);

    const stats = {
      runAt: now.toISOString(),
      durationMs: Date.now() - startTime,
      orphaned,
      expired,
      stale,
      couponExpired,
      checkoutStale,
      totalRepaired:
        orphaned.repaired +
        expired.released +
        stale.cleaned +
        (couponExpired.expired || 0) +
        (checkoutStale.cleaned || 0),
      totalErrors:
        orphaned.errors.length +
        expired.errors.length +
        stale.errors.length +
        couponExpired.errors.length +
        checkoutStale.errors.length,
    };

    lastRunAt = now;
    lastRunStats = stats;

    if (stats.totalRepaired > 0 || stats.totalErrors > 0) {
      console.info("[repair-job] Completed:", JSON.stringify(stats, null, 2));
    } else {
      console.info("[repair-job] Completed - no repairs needed");
    }

    return stats;
  } catch (err) {
    console.error("[repair-job] Fatal error:", String(err?.message || err));
    return { error: String(err?.message || err) };
  } finally {
    isRunning = false;
  }
}

/**
 * Start the background repair job with periodic execution.
 *
 * @param {Object} options
 * @param {number} options.intervalMs - Interval between runs (default: 3 minutes)
 * @returns {Object} - Control object with stop() method and status getter
 */
export function startReservationRepairJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (intervalId) {
    console.warn("[repair-job] Job already running, ignoring start request");
    return getRepairJobStatus();
  }

  console.info(`[repair-job] Starting with interval ${intervalMs}ms`);

  // Run immediately on start
  runRepairJob().catch((err) => {
    console.error("[repair-job] Initial run failed:", String(err?.message || err));
  });

  // Schedule periodic runs
  intervalId = setInterval(() => {
    runRepairJob().catch((err) => {
      console.error("[repair-job] Scheduled run failed:", String(err?.message || err));
    });
  }, intervalMs);

  // Don't block process exit
  if (intervalId.unref) {
    intervalId.unref();
  }

  return getRepairJobStatus();
}

/**
 * Stop the background repair job.
 */
export function stopReservationRepairJob() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.info("[repair-job] Stopped");
  }
}

/**
 * Get current job status
 */
export function getRepairJobStatus() {
  return {
    running: !!intervalId,
    currentlyExecuting: isRunning,
    lastRunAt,
    lastRunStats,
  };
}

/**
 * Manually trigger a repair run (for admin endpoint)
 * Returns the run stats.
 */
export async function triggerRepairJob() {
  return runRepairJob();
}

/**
 * Export for direct import/testing
 */
export {
  runRepairJob,
  repairOrphanedReservations,
  releaseExpiredReservations,
  cleanupStaleConfirmedReservations,
};
