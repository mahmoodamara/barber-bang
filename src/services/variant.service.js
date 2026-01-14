// src/services/variant.service.js
import mongoose from "mongoose";
import { Variant } from "../models/Variant.js";
import { StockLog } from "../models/StockLog.js";
import { toMinorUnits, ensureMinorUnitsInt } from "../utils/stripe.js";
import { recomputeProductsInStock } from "./stock.service.js";

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export async function createVariant(productId, payload) {
  const currency = payload.currency || "ILS";
  const priceMinor = toMinorUnits(payload.price, currency);
  ensureMinorUnitsInt(priceMinor);

  return Variant.create({
    productId: oid(productId),
    sku: payload.sku,
    barcode: payload.barcode,
    price: priceMinor,
    currency,
    stock: payload.stock ?? 0,
    stockReserved: 0,
    options: payload.options || {},
    isActive: payload.isActive ?? true,
    sortOrder: payload.sortOrder ?? 0,
  }).then(async (doc) => {
    await recomputeProductsInStock([productId]);
    return doc;
  });
}

export async function updateVariant(variantId, patch) {
  const v = await Variant.findOne({ _id: variantId, isDeleted: { $ne: true } });
  if (!v) {
    throw httpError(404, "VARIANT_NOT_FOUND", "Variant not found");
  }

  const setIf = (k, val) => {
    if (val !== undefined) v[k] = val;
  };

  setIf("sku", patch.sku);
  setIf("barcode", patch.barcode);

  if (patch.price !== undefined) {
    const currency = patch.currency || v.currency || "ILS";
    const priceMinor = toMinorUnits(patch.price, currency);
    ensureMinorUnitsInt(priceMinor);
    v.price = priceMinor;
  }

  setIf("currency", patch.currency);
  setIf("options", patch.options);
  setIf("isActive", patch.isActive);
  setIf("sortOrder", patch.sortOrder);

  if (patch.stock !== undefined) {
    const nextStock = Number(patch.stock);
    if (!Number.isFinite(nextStock)) {
      throw httpError(400, "INVALID_STOCK", "stock must be a finite number");
    }
    if (nextStock < (v.stockReserved || 0)) {
      throw httpError(400, "STOCK_BELOW_RESERVED", "stock cannot be below reserved stock");
    }
    v.stock = nextStock;
  }

  const stockChanged = patch.stock !== undefined || patch.isActive !== undefined;
  await v.save();

  if (stockChanged) {
    await recomputeProductsInStock([String(v.productId)]);
  }

  return v;
}

export async function softDeleteVariant(variantId) {
  const v = await Variant.findOne({ _id: variantId, isDeleted: { $ne: true } });
  if (!v) {
    throw httpError(404, "VARIANT_NOT_FOUND", "Variant not found");
  }
  v.isActive = false;
  v.isDeleted = true;
  v.deletedAt = new Date();
  await v.save();
  await recomputeProductsInStock([String(v.productId)]);
  return v;
}

/**
 * Atomic stock adjust:
 * - Uses Mongo transaction so Variant stock update + StockLog insert are all-or-nothing.
 * - Recompute in-stock AFTER commit (outside transaction) to avoid inconsistent derived updates.
 *
 * Requirements:
 * - Mongo must be running as a replica set for transactions.
 * - If not available, you can add a "best effort" fallback (not recommended for admin).
 */
export async function adjustVariantStock({ variantId, delta, reason, actorId, ctx } = {}) {
  const _id = oid(variantId);
  const inc = Number(delta);

  if (!Number.isFinite(inc) || inc === 0) {
    throw httpError(422, "INVALID_DELTA", "delta must be a non-zero finite number");
  }

  const session = await mongoose.startSession();
  let updated = null;

  try {
    await session.withTransaction(async () => {
      updated = await Variant.findOneAndUpdate(
        {
          _id,
          isDeleted: { $ne: true },
          $expr: {
            $and: [
              { $gte: [{ $add: ["$stock", inc] }, "$stockReserved"] },
              { $gte: [{ $add: ["$stock", inc] }, 0] },
            ],
          },
        },
        { $inc: { stock: inc } },
        { new: true, session },
      );

      if (!updated) {
        throw httpError(400, "STOCK_CONSTRAINT_FAILED", "Stock constraint failed");
      }

      await StockLog.create(
        [
          {
            variantId: updated._id,
            type: "manual_adjust",
            deltaStock: inc,
            deltaReserved: 0,
            actorId: actorId ? oid(actorId) : null,
            reason: String(reason || "").trim() || null,
            meta: {
              newStock: updated.stock,
              stockReserved: updated.stockReserved || 0,
              requestId: ctx?.requestId || null,
              ip: ctx?.ip || null,
            },
          },
        ],
        { session },
      );
    });
  } finally {
    session.endSession();
  }

  // Derived recompute after commit (safe)
  await recomputeProductsInStock([String(updated.productId)]);
  return updated;
}
