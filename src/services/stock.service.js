// src/services/stock.service.js
//
// Stock reservation + confirmation with per-order ownership (StockReservation)
// - All operations are transactional + idempotent
// - Prevents oversell and partial decrements
// - Updates Product.inStock on every stock mutation path
// - Logs are best-effort (do not block core flows)

import mongoose from "mongoose";
import { Variant } from "../models/Variant.js";
import { Product } from "../models/Product.js";
import { StockLog } from "../models/StockLog.js";
import { StockReservation } from "../models/StockReservation.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

const { Types } = mongoose;

function oid(id) {
  if (!id) {
    const err = new Error("INVALID_OBJECT_ID");
    err.statusCode = 400;
    throw err;
  }
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));
}

function mergeItems(items = []) {
  const merged = new Map(); // variantId(string) -> { quantity, productId }
  for (const it of items) {
    const variantId = it?.variantId;
    const qty = Number(it?.quantity ?? it?.qty ?? 0);
    if (!variantId) continue;
    if (!Number.isInteger(qty) || qty <= 0) continue;

    const key = String(variantId);
    const entry = merged.get(key) || { quantity: 0, productId: it?.productId || null };
    entry.quantity += qty;
    if (!entry.productId && it?.productId) entry.productId = it.productId;
    merged.set(key, entry);
  }
  return merged;
}

function activeFilter(requireActive) {
  return requireActive ? { isActive: true, isDeleted: { $ne: true } } : {};
}

async function withSession(session, work) {
  if (session) return await work(session);
  return await withRequiredTransaction(work);
}

async function tryInsertLogs(logs) {
  if (!logs?.length) return;
  try {
    await StockLog.insertMany(logs, { ordered: false });
  } catch {
    // best-effort only
  }
}

function collectProductIds(merged) {
  const set = new Set();
  for (const entry of merged.values()) {
    if (entry?.productId) set.add(String(entry.productId));
  }
  return [...set];
}

async function mapVariantIdsToProductIds(variantIds, session) {
  if (!variantIds.length) return new Map();
  const rows = await applyQueryBudget(
    Variant.find({ _id: { $in: variantIds } })
      .select("_id productId")
      .session(session)
      .lean(),
  );
  return new Map(rows.map((r) => [String(r._id), String(r.productId)]));
}

async function updateProductsInStock(productIds, session) {
  const unique = [...new Set(productIds.filter(Boolean))].map(oid);
  if (!unique.length) return;

  const agg = await applyQueryBudget(
    Variant.aggregate([
      {
        $match: {
          productId: { $in: unique },
          isActive: true,
          isDeleted: { $ne: true },
        },
      },
      {
        $project: {
          productId: 1,
          available: { $subtract: ["$stock", "$stockReserved"] },
        },
      },
      {
        $group: {
          _id: "$productId",
          anyAvailable: {
            $max: {
              $cond: [{ $gt: ["$available", 0] }, 1, 0],
            },
          },
        },
      },
    ]).session(session),
  );

  const byId = new Map(agg.map((r) => [String(r._id), r.anyAvailable === 1]));

  const bulk = unique.map((id) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { inStock: byId.get(String(id)) === true } },
    },
  }));

  await Product.bulkWrite(bulk, { session });
}

export async function recomputeProductsInStock(productIds, { session } = {}) {
  return await withSession(session, async (s) => {
    await updateProductsInStock(productIds, s);
    return true;
  });
}

/**
 * Reserve stock atomically per order/variant.
 * Ensures (stock - stockReserved) >= qty.
 */
export async function reserveStock(orderId, items, { session, requireActive = true, expiresAt = null } = {}) {
  const merged = mergeItems(items);
  if (!merged.size) return true;

  const orderObjectId = oid(orderId);
  const variantIds = [...merged.keys()].map(oid);
  const now = new Date();

  return await withSession(session, async (s) => {
    const existing = await applyQueryBudget(
      StockReservation.find({
        orderId: orderObjectId,
        variantId: { $in: variantIds },
      })
        .session(s)
        .lean(),
    );

    const existingMap = new Map(existing.map((r) => [String(r.variantId), r]));
    const logs = [];

    let productIds = collectProductIds(merged);
    const missingProductIds = productIds.length < merged.size;
    const variantToProduct = missingProductIds ? await mapVariantIdsToProductIds(variantIds, s) : null;

    for (const [variantId, entry] of merged.entries()) {
      const quantity = entry.quantity;
      const existingRes = existingMap.get(variantId);

      if (existingRes) {
        if (existingRes.status === "reserved" || existingRes.status === "confirmed") {
          if (existingRes.quantity !== quantity) {
            const err = new Error("RESERVATION_QTY_MISMATCH");
            err.statusCode = 409;
            throw err;
          }
          continue; // idempotent
        }
        if (existingRes.status === "released") {
          const err = new Error("RESERVATION_ALREADY_RELEASED");
          err.statusCode = 409;
          throw err;
        }
      }

      const res = await Variant.updateOne(
        {
          _id: oid(variantId),
          ...activeFilter(requireActive),
          $expr: { $gte: [{ $subtract: ["$stock", "$stockReserved"] }, quantity] },
        },
        { $inc: { stockReserved: quantity } },
        { session: s },
      );

      if (res.modifiedCount !== 1) {
        const err = new Error("OUT_OF_STOCK");
        err.statusCode = 409;
        throw err;
      }

      const productId = entry.productId || (variantToProduct ? variantToProduct.get(variantId) : null);

      await StockReservation.create(
        [
          {
            orderId: orderObjectId,
            variantId: oid(variantId),
            productId: productId ? oid(productId) : null,
            quantity,
            status: "reserved",
            reservedAt: now,
            expiresAt: expiresAt || null,
          },
        ],
        { session: s },
      );

      logs.push({
        variantId: oid(variantId),
        type: "reserve",
        deltaStock: 0,
        deltaReserved: quantity,
        orderId: orderObjectId,
        meta: { quantity },
      });
    }

    if (missingProductIds && variantToProduct) {
      productIds = [
        ...new Set([
          ...productIds,
          ...variantIds.map((v) => variantToProduct.get(String(v))).filter(Boolean),
        ]),
      ];
    }

    await updateProductsInStock(productIds, s);
    await tryInsertLogs(logs);
    return true;
  });
}

/**
 * Confirm stock after successful payment:
 * - stock -= qty
 * - stockReserved -= qty
 */
export async function confirmStock(orderId, items, { session, requireActive = true, allowLegacy = false } = {}) {
  const merged = mergeItems(items);
  if (!merged.size) return true;

  const orderObjectId = oid(orderId);
  const variantIds = [...merged.keys()].map(oid);
  const now = new Date();

  return await withSession(session, async (s) => {
    const reservations = await applyQueryBudget(
      StockReservation.find({
        orderId: orderObjectId,
        variantId: { $in: variantIds },
      })
        .session(s)
        .lean(),
    );

    const resMap = new Map(reservations.map((r) => [String(r.variantId), r]));
    const logs = [];

    let productIds = collectProductIds(merged);
    const missingProductIds = productIds.length < merged.size;
    const variantToProduct = missingProductIds ? await mapVariantIdsToProductIds(variantIds, s) : null;

    for (const [variantId, entry] of merged.entries()) {
      const quantity = entry.quantity;
      let reservation = resMap.get(variantId);

      if (!reservation) {
        if (!allowLegacy) {
          const err = new Error("RESERVATION_NOT_FOUND");
          err.statusCode = 409;
          throw err;
        }
        const productId = entry.productId || (variantToProduct ? variantToProduct.get(variantId) : null);
        reservation = await StockReservation.findOneAndUpdate(
          { orderId: orderObjectId, variantId: oid(variantId) },
          {
            $setOnInsert: {
              orderId: orderObjectId,
              variantId: oid(variantId),
              productId: productId ? oid(productId) : null,
              quantity,
              status: "reserved",
              reservedAt: now,
            },
          },
          { session: s, upsert: true, new: true },
        ).lean();
      }

      if (reservation.quantity !== quantity) {
        const err = new Error("RESERVATION_QTY_MISMATCH");
        err.statusCode = 409;
        throw err;
      }

      if (reservation.status === "confirmed") {
        continue; // idempotent
      }
      if (reservation.status === "released") {
        const err = new Error("RESERVATION_ALREADY_RELEASED");
        err.statusCode = 409;
        throw err;
      }

      const res = await Variant.updateOne(
        {
          _id: oid(variantId),
          ...activeFilter(requireActive),
          stock: { $gte: quantity },
          stockReserved: { $gte: quantity },
        },
        { $inc: { stock: -quantity, stockReserved: -quantity } },
        { session: s },
      );

      if (res.modifiedCount !== 1) {
        const err = new Error("STOCK_CONFIRM_MISMATCH");
        err.statusCode = 409;
        throw err;
      }

      if (reservation._id) {
        await StockReservation.updateOne(
          { _id: reservation._id, status: "reserved" },
          { $set: { status: "confirmed", confirmedAt: now } },
          { session: s },
        );
      }

      logs.push({
        variantId: oid(variantId),
        type: "confirm_paid",
        deltaStock: -quantity,
        deltaReserved: -quantity,
        orderId: orderObjectId,
        meta: { quantity },
      });
    }

    if (missingProductIds && variantToProduct) {
      productIds = [
        ...new Set([
          ...productIds,
          ...variantIds.map((v) => variantToProduct.get(String(v))).filter(Boolean),
        ]),
      ];
    }

    await updateProductsInStock(productIds, s);
    await tryInsertLogs(logs);
    return true;
  });
}

/**
 * Release reserved stock (cancel/expiry).
 */
export async function releaseReservedStockBulk(
  orderId,
  items,
  { session, requireActive = false, reason = "", allowLegacy = false } = {},
) {
  const merged = mergeItems(items);
  if (!merged.size) return true;

  const orderObjectId = oid(orderId);
  const variantIds = [...merged.keys()].map(oid);
  const now = new Date();

  return await withSession(session, async (s) => {
    const reservations = await applyQueryBudget(
      StockReservation.find({
        orderId: orderObjectId,
        variantId: { $in: variantIds },
      })
        .session(s)
        .lean(),
    );

    const resMap = new Map(reservations.map((r) => [String(r.variantId), r]));
    const logs = [];

    let productIds = collectProductIds(merged);
    const missingProductIds = productIds.length < merged.size;
    const variantToProduct = missingProductIds ? await mapVariantIdsToProductIds(variantIds, s) : null;

    for (const [variantId, entry] of merged.entries()) {
      const quantity = entry.quantity;
      let reservation = resMap.get(variantId);

      if (!reservation) {
        if (!allowLegacy) {
          const err = new Error("RESERVATION_NOT_FOUND");
          err.statusCode = 409;
          throw err;
        }
        const productId = entry.productId || (variantToProduct ? variantToProduct.get(variantId) : null);
        reservation = await StockReservation.findOneAndUpdate(
          { orderId: orderObjectId, variantId: oid(variantId) },
          {
            $setOnInsert: {
              orderId: orderObjectId,
              variantId: oid(variantId),
              productId: productId ? oid(productId) : null,
              quantity,
              status: "reserved",
              reservedAt: now,
            },
          },
          { session: s, upsert: true, new: true },
        ).lean();
      }

      if (reservation.quantity !== quantity) {
        const err = new Error("RESERVATION_QTY_MISMATCH");
        err.statusCode = 409;
        throw err;
      }

      if (reservation.status === "confirmed") {
        const err = new Error("RESERVATION_ALREADY_CONFIRMED");
        err.statusCode = 409;
        throw err;
      }
      if (reservation.status === "released") {
        continue; // idempotent
      }

      const res = await Variant.updateOne(
        {
          _id: oid(variantId),
          ...activeFilter(requireActive),
          stockReserved: { $gte: quantity },
        },
        { $inc: { stockReserved: -quantity } },
        { session: s },
      );

      if (res.modifiedCount !== 1) {
        const err = new Error("RESERVE_RELEASE_MISMATCH");
        err.statusCode = 409;
        throw err;
      }

      if (reservation._id) {
        await StockReservation.updateOne(
          { _id: reservation._id, status: "reserved" },
          { $set: { status: "released", releasedAt: now, reason: reason || "" } },
          { session: s },
        );
      }

      logs.push({
        variantId: oid(variantId),
        type: "release_reserve",
        deltaStock: 0,
        deltaReserved: -quantity,
        orderId: orderObjectId,
        reason,
        meta: { quantity },
      });
    }

    if (missingProductIds && variantToProduct) {
      productIds = [
        ...new Set([
          ...productIds,
          ...variantIds.map((v) => variantToProduct.get(String(v))).filter(Boolean),
        ]),
      ];
    }

    await updateProductsInStock(productIds, s);
    await tryInsertLogs(logs);
    return true;
  });
}

/**
 * Backward-compat alias (Phase 3 code might call releaseReservedStock)
 */
export const releaseReservedStock = releaseReservedStockBulk;

/**
 * Restore stock on refund (full or partial restockItems).
 * itemsOrRestockItems: [{variantId, quantity, productId?}]
 */
export async function refundRestoreStockBulk(orderId, itemsOrRestockItems, meta = {}, { session } = {}) {
  const merged = mergeItems(itemsOrRestockItems);
  if (!merged.size) return true;

  const orderObjectId = orderId ? oid(orderId) : null;
  const variantIds = [...merged.keys()].map(oid);

  return await withSession(session, async (s) => {
    const logs = [];

    let productIds = collectProductIds(merged);
    const missingProductIds = productIds.length < merged.size;
    const variantToProduct = missingProductIds ? await mapVariantIdsToProductIds(variantIds, s) : null;

    for (const [variantId, entry] of merged.entries()) {
      const quantity = entry.quantity;

      await Variant.updateOne(
        { _id: oid(variantId) },
        { $inc: { stock: quantity } },
        { session: s },
      );

      logs.push({
        variantId: oid(variantId),
        type: "refund_restore",
        deltaStock: quantity,
        deltaReserved: 0,
        orderId: orderObjectId,
        reason: meta?.mode || "refund",
        meta: { ...meta, quantity },
      });
    }

    if (missingProductIds && variantToProduct) {
      productIds = [
        ...new Set([
          ...productIds,
          ...variantIds.map((v) => variantToProduct.get(String(v))).filter(Boolean),
        ]),
      ];
    }

    await updateProductsInStock(productIds, s);
    await tryInsertLogs(logs);
    return true;
  });
}
