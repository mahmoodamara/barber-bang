// src/services/products.service.js
import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { StockReservation } from "../models/StockReservation.js";

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeItems(items) {
  return (items || [])
    .map((it) => ({
      productId: String(it.productId || ""),
      qty: Math.max(1, Math.min(999, Number(it.qty || 0))),
      variantId: String(it.variantId || ""),
    }))
    .filter((it) => it.productId && it.qty > 0);
}

function toVariantObjectId(id) {
  const v = String(id || "").trim();
  if (!v) return null;
  return mongoose.Types.ObjectId.isValid(v)
    ? new mongoose.Types.ObjectId(v)
    : null;
}

/**
 * Inventory policy (used by decrement and release):
 * - trackInventory === false: do not decrement or restore stock; product is always "available".
 * - allowBackorder === true: allow order even when stock < qty (stock may go negative).
 * - Otherwise: require stock >= qty for decrement; restore on release.
 */
async function getProductInventoryFlags(productIds, session = null) {
  if (!productIds.length) return new Map();
  const products = await Product.find({ _id: { $in: productIds } })
    .select("trackInventory allowBackorder")
    .lean();
  return new Map(products.map((p) => [String(p._id), p]));
}

export async function decrementStockAtomicOrThrow(items, session = null) {
  const list = normalizeItems(items);
  if (!list.length) return;

  const productIds = [...new Set(list.map((it) => it.productId))];
  const flagsByProduct = await getProductInventoryFlags(productIds, session);

  const updated = [];

  try {
    for (const it of list) {
      const qty = Number(it.qty || 0);
      const variantObjId = toVariantObjectId(it.variantId);
      const isVariant = Boolean(variantObjId);

      const product = flagsByProduct.get(it.productId);
      if (!product) {
        throw makeErr(
          400,
          "OUT_OF_STOCK",
          "One or more items are out of stock",
        );
      }

      // trackInventory === false: do not decrement stock (product always "in stock")
      if (product.trackInventory === false) {
        continue;
      }

      const allowBackorder = product.allowBackorder === true;

      const filter = {
        _id: it.productId,
        isActive: true,
      };
      if (isVariant) {
        filter["variants._id"] = variantObjId;
        if (!allowBackorder) {
          filter["variants.stock"] = { $gte: qty };
        }
      } else {
        if (!allowBackorder) {
          filter.stock = { $gte: qty };
        }
      }

      const update = isVariant
        ? { $inc: { "variants.$.stock": -qty } }
        : { $inc: { stock: -qty } };

      const res = await Product.updateOne(
        filter,
        update,
        session ? { session } : {},
      );

      if (Number(res?.modifiedCount || 0) !== 1) {
        throw makeErr(
          400,
          "OUT_OF_STOCK",
          "One or more items are out of stock",
        );
      }

      updated.push(it);
    }
  } catch (e) {
    if (updated.length) {
      await restoreStockForItems(updated, session).catch((err) => {
        console.warn(
          "[best-effort] products restore stock failed:",
          String(err?.message || err),
        );
      });
    }
    throw e;
  }
}

async function restoreStockForItems(items, session = null) {
  if (!items.length) return;
  const ops = items.map((it) => {
    const qty = Number(it.qty || 0);
    const variantObjId = toVariantObjectId(it.variantId);
    const isVariant = Boolean(variantObjId);

    return isVariant
      ? {
          updateOne: {
            filter: { _id: it.productId, "variants._id": variantObjId },
            update: { $inc: { "variants.$.stock": qty } },
          },
        }
      : {
          updateOne: {
            filter: { _id: it.productId },
            update: { $inc: { stock: qty } },
          },
        };
  });

  await Product.bulkWrite(ops, {
    ordered: true,
    ...(session ? { session } : {}),
  });
}

/**
 * Restore stock for returned items.
 * Each item needs { productId, qty, variantId? }.
 * Respects trackInventory flag — skips products that don't track inventory.
 */
export async function restockReturnedItems(items) {
  const list = normalizeItems(items);
  if (!list.length) return { restocked: 0 };

  const productIds = [...new Set(list.map((it) => it.productId))];
  const flags = await getProductInventoryFlags(productIds);

  const trackable = list.filter((it) => {
    const f = flags.get(it.productId);
    return !f || f.trackInventory !== false;
  });

  if (!trackable.length) return { restocked: 0 };

  await restoreStockForItems(trackable);
  return { restocked: trackable.length };
}

export async function reserveStockForOrder({
  orderId,
  userId,
  items,
  ttlMinutes = 15,
  session = null,
}) {
  if (!orderId) throw makeErr(400, "MISSING_ORDER_ID", "orderId is required");

  const list = normalizeItems(items);
  if (!list.length) throw makeErr(400, "EMPTY_ITEMS", "No items to reserve");

  const now = new Date();
  const expiresAt =
    ttlMinutes && ttlMinutes > 0
      ? new Date(Date.now() + ttlMinutes * 60 * 1000)
      : null;

  const existing = await StockReservation.findOne(
    { orderId },
    null,
    session ? { session } : {},
  );

  if (existing) {
    if (existing.status === "confirmed") return existing;
    if (
      existing.status === "reserved" &&
      (!existing.expiresAt || existing.expiresAt > now)
    ) {
      if (expiresAt) {
        await StockReservation.updateOne(
          { _id: existing._id, status: "reserved" },
          { $set: { expiresAt } },
          session ? { session } : {},
        );
      }
      return existing;
    }

    if (
      existing.status === "reserved" &&
      existing.expiresAt &&
      existing.expiresAt <= now
    ) {
      await releaseStockReservation({ orderId, session }).catch((err) => {
        console.warn(
          "[best-effort] products release stock reservation failed:",
          String(err?.message || err),
        );
      });
    }
  }

  let stockReserved = false;
  try {
    await decrementStockAtomicOrThrow(list, session);
    stockReserved = true;

    const reservation = await StockReservation.findOneAndUpdate(
      { orderId },
      {
        $set: {
          userId: userId || null,
          items: list,
          status: "reserved",
          expiresAt,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        ...(session ? { session } : {}),
      },
    );

    return reservation;
  } catch (e) {
    if (stockReserved) {
      await restoreStockForItems(list, session).catch((err) => {
        console.warn(
          "[best-effort] products restore stock failed:",
          String(err?.message || err),
        );
      });
    }
    throw e;
  }
}

export async function confirmStockReservation({
  orderId,
  session = null,
  now = new Date(),
} = {}) {
  if (!orderId) return null;

  const existing = await StockReservation.findOne(
    { orderId },
    null,
    session ? { session } : {},
  );
  if (!existing) return null;
  if (existing.status === "confirmed") return existing;

  if (existing.status !== "reserved") return null;
  if (existing.expiresAt && existing.expiresAt <= now) return null;

  const updated = await StockReservation.findOneAndUpdate(
    {
      _id: existing._id,
      status: "reserved",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    },
    { $set: { status: "confirmed", expiresAt: null } },
    { new: true, ...(session ? { session } : {}) },
  );

  if (updated) return updated;

  const fresh = await StockReservation.findOne(
    { orderId },
    null,
    session ? { session } : {},
  );
  if (fresh && fresh.status === "confirmed") return fresh;

  return null;
}

export async function releaseStockReservation({ orderId, session = null }) {
  if (!orderId) return null;

  const reservation = await StockReservation.findOneAndUpdate(
    { orderId, status: "reserved" },
    { $set: { status: "released", expiresAt: new Date() } },
    { new: true, ...(session ? { session } : {}) },
  );

  if (!reservation) return null;

  const items = reservation.items || [];
  if (items.length) {
    const productIds = [...new Set(items.map((it) => it.productId))];
    const flagsByProduct = await getProductInventoryFlags(productIds, session);
    for (const it of items) {
      const product = flagsByProduct.get(it.productId);
      if (product && product.trackInventory === false) {
        continue; // We never decremented these; do not restore
      }
      const qty = Number(it.qty || 0);
      const variantObjId = toVariantObjectId(it.variantId);
      const isVariant = Boolean(variantObjId);
      if (isVariant) {
        await Product.updateOne(
          { _id: it.productId, "variants._id": variantObjId },
          { $inc: { "variants.$.stock": qty } },
          session ? { session } : {},
        );
      } else {
        await Product.updateOne(
          { _id: it.productId },
          { $inc: { stock: qty } },
          session ? { session } : {},
        );
      }
    }
  }

  return reservation;
}

export async function releaseExpiredReservations({
  now = new Date(),
  limit = 200,
} = {}) {
  const reservations = await StockReservation.find({
    status: "reserved",
    expiresAt: { $lte: now },
  })
    .limit(limit)
    .lean();

  if (!reservations.length) return 0;

  for (const r of reservations) {
    const updated = await StockReservation.findOneAndUpdate(
      { _id: r._id, status: "reserved" },
      { $set: { status: "expired", expiresAt: now } },
    );

    if (!updated) continue;

    const items = r.items || [];
    if (items.length) {
      const productIds = [...new Set(items.map((it) => it.productId))];
      const flagsByProduct = await getProductInventoryFlags(productIds, null);
      for (const it of items) {
        const product = flagsByProduct.get(it.productId);
        if (product && product.trackInventory === false) {
          continue;
        }
        const qty = Number(it.qty || 0);
        const variantObjId = toVariantObjectId(it.variantId);
        const isVariant = Boolean(variantObjId);
        if (isVariant) {
          await Product.updateOne(
            { _id: it.productId, "variants._id": variantObjId },
            { $inc: { "variants.$.stock": qty } },
          );
        } else {
          await Product.updateOne(
            { _id: it.productId },
            { $inc: { stock: qty } },
          );
        }
      }
    }
  }

  return reservations.length;
}

/* ============================================
   RESERVATION CONSISTENCY & REPAIR UTILITIES
   ============================================

   These functions handle edge cases where crashes or failures
   may leave stock in an inconsistent state.
*/

/**
 * Find and repair orphaned reservations (reserved but no matching order)
 * This handles the crash window where stock was decremented but order creation failed.
 *
 * @param {Object} options
 * @param {Date} options.olderThan - Only check reservations older than this date (default: 5 minutes ago)
 * @param {number} options.limit - Max reservations to process per run
 * @returns {Promise<{repaired: number, errors: string[]}>}
 */
export async function repairOrphanedReservations({
  olderThan = new Date(Date.now() - 5 * 60 * 1000),
  limit = 100,
} = {}) {
  const { Order } = await import("../models/Order.js");

  const reservations = await StockReservation.find({
    status: "reserved",
    createdAt: { $lt: olderThan },
  })
    .limit(limit)
    .lean();

  let repaired = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      // Check if order exists
      const orderExists = await Order.exists({ _id: r.orderId });

      if (!orderExists) {
        // Orphaned reservation - release stock
        const released = await releaseStockReservation({ orderId: r.orderId });
        if (released) {
          console.info(
            `[repair] Released orphaned reservation for orderId=${r.orderId}`,
          );
          repaired++;
        }
      }
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { repaired, errors };
}

/**
 * Verify stock consistency for a specific order
 * Returns true if reservation and order are in consistent state
 *
 * @param {ObjectId|string} orderId
 * @returns {Promise<{consistent: boolean, details: string}>}
 */
export async function verifyOrderStockConsistency(orderId) {
  const { Order } = await import("../models/Order.js");

  const [reservation, order] = await Promise.all([
    StockReservation.findOne({ orderId }).lean(),
    Order.findById(orderId).select("status").lean(),
  ]);

  if (!reservation && !order) {
    return {
      consistent: true,
      details: "Neither reservation nor order exists",
    };
  }

  if (!reservation && order) {
    // Order exists without reservation - might be legacy or confirmed
    const terminalStatuses = ["delivered", "cancelled", "refunded"];
    if (terminalStatuses.includes(order.status)) {
      return {
        consistent: true,
        details: "Order in terminal state, no reservation needed",
      };
    }
    return {
      consistent: false,
      details: "Order exists but no reservation found",
    };
  }

  if (reservation && !order) {
    if (reservation.status === "reserved") {
      return {
        consistent: false,
        details: "Orphaned reservation - order missing",
      };
    }
    return {
      consistent: true,
      details: "Reservation released/expired, order cleaned up",
    };
  }

  // Both exist - check status alignment
  if (
    reservation.status === "confirmed" &&
    order.status !== "pending_payment"
  ) {
    return {
      consistent: true,
      details: "Stock confirmed and order progressed",
    };
  }

  if (
    reservation.status === "reserved" &&
    ["pending_payment", "pending_cod"].includes(order.status)
  ) {
    return {
      consistent: true,
      details: "Pending order with active reservation",
    };
  }

  return { consistent: true, details: "States appear consistent" };
}

/**
 * Repair confirmed reservations where the order was cancelled/refunded
 * but the reservation wasn't cleaned up.
 *
 * @param {Object} options
 * @param {number} options.limit - Max to process per run
 * @returns {Promise<{cleaned: number, errors: string[]}>}
 */
export async function cleanupStaleConfirmedReservations({ limit = 100 } = {}) {
  const { Order } = await import("../models/Order.js");

  // Find confirmed reservations
  const reservations = await StockReservation.find({
    status: "confirmed",
  })
    .limit(limit)
    .lean();

  let cleaned = 0;
  const errors = [];

  for (const r of reservations) {
    try {
      const order = await Order.findById(r.orderId).select("status").lean();

      // If order doesn't exist or is in terminal cancelled/refunded state,
      // mark reservation as released (stock already consumed, no restore needed)
      if (!order || ["cancelled", "refunded"].includes(order.status)) {
        await StockReservation.updateOne(
          { _id: r._id, status: "confirmed" },
          { $set: { status: "released" } },
        );
        console.info(
          `[cleanup] Marked stale confirmed reservation as released for orderId=${r.orderId}`,
        );
        cleaned++;
      }
    } catch (err) {
      errors.push(`orderId=${r.orderId}: ${String(err?.message || err)}`);
    }
  }

  return { cleaned, errors };
}
