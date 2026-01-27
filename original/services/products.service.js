// src/services/products.service.js
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
    }))
    .filter((it) => it.productId && it.qty > 0);
}

export async function decrementStockAtomicOrThrow(items, session = null) {
  const list = normalizeItems(items);
  if (!list.length) return;

  const ops = list.map((it) => ({
    updateOne: {
      filter: {
        _id: it.productId,
        isActive: true,
        stock: { $gte: Number(it.qty || 0) },
      },
      update: { $inc: { stock: -Number(it.qty || 0) } },
    },
  }));

  const result = await Product.bulkWrite(ops, {
    ordered: true,
    ...(session ? { session } : {}),
  });

  const matched = Number(result?.matchedCount || 0);
  if (matched !== ops.length) {
    throw makeErr(400, "OUT_OF_STOCK", "One or more items are out of stock");
  }
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

  const existing = await StockReservation.findOne(
    { orderId },
    null,
    session ? { session } : {}
  );
  if (existing && ["reserved", "confirmed"].includes(existing.status)) {
    return existing;
  }

  const updated = [];

  try {
    for (const it of list) {
      const res = await Product.updateOne(
        {
          _id: it.productId,
          isActive: true,
          stock: { $gte: Number(it.qty || 0) },
        },
        { $inc: { stock: -Number(it.qty || 0) } },
        session ? { session } : {}
      );

      if (Number(res?.matchedCount || 0) !== 1) {
        throw makeErr(400, "OUT_OF_STOCK", "One or more items are out of stock");
      }

      updated.push(it);
    }

    const expiresAt =
      ttlMinutes && ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60 * 1000) : null;

    const reservation = await StockReservation.create(
      [
        {
          orderId,
          userId: userId || null,
          items: list,
          status: "reserved",
          expiresAt,
        },
      ],
      session ? { session } : {}
    );

    return reservation?.[0] || reservation;
  } catch (e) {
    if (updated.length) {
      for (const it of updated) {
        await Product.updateOne(
          { _id: it.productId },
          { $inc: { stock: Number(it.qty || 0) } },
          session ? { session } : {}
        );
      }
    }
    throw e;
  }
}

export async function confirmStockReservation({ orderId, session = null }) {
  if (!orderId) return null;

  const existing = await StockReservation.findOne({ orderId }, null, session ? { session } : {});
  if (!existing) return null;
  if (existing.status === "confirmed") return existing;

  if (existing.status !== "reserved") return null;

  const updated = await StockReservation.findOneAndUpdate(
    { _id: existing._id, status: "reserved" },
    { $set: { status: "confirmed", expiresAt: null } },
    { new: true, ...(session ? { session } : {}) }
  );

  return updated;
}

export async function releaseStockReservation({ orderId, session = null }) {
  if (!orderId) return null;

  const reservation = await StockReservation.findOneAndUpdate(
    { orderId, status: "reserved" },
    { $set: { status: "released", expiresAt: new Date() } },
    { new: true, ...(session ? { session } : {}) }
  );

  if (!reservation) return null;

  for (const it of reservation.items || []) {
    await Product.updateOne(
      { _id: it.productId },
      { $inc: { stock: Number(it.qty || 0) } },
      session ? { session } : {}
    );
  }

  return reservation;
}

export async function releaseExpiredReservations({ now = new Date(), limit = 200 } = {}) {
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
      { $set: { status: "expired", expiresAt: now } }
    );

    if (!updated) continue;

    for (const it of r.items || []) {
      await Product.updateOne({ _id: it.productId }, { $inc: { stock: Number(it.qty || 0) } });
    }
  }

  return reservations.length;
}
