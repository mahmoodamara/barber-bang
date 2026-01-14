import mongoose from "mongoose";

import { ReturnRequest } from "../models/ReturnRequest.js";
import { Order } from "../models/Order.js";
import { ORDER_STATUS } from "../utils/orderState.js";
import { parsePagination } from "../utils/paginate.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import {
  buildListEnvelope,
  buildSearchOrFilter,
  parseAdminPagination,
  parseSort,
} from "../utils/adminQuery.js";

import {
  reserveStock,
  confirmStock,
  releaseReservedStockBulk,
  refundRestoreStockBulk,
} from "./stock.service.js";

const { Types } = mongoose;

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function oid(v, code = "INVALID_ID") {
  const s = String(v || "");
  if (!Types.ObjectId.isValid(s)) throw httpError(400, code, code);
  return new Types.ObjectId(s);
}

function strId(v) {
  if (!v) return null;
  return String(v);
}

function normalizeRoles(roles) {
  return Array.isArray(roles) ? roles.map((r) => String(r)).filter(Boolean).slice(0, 20) : [];
}

function toReturnDTO(docOrLean) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;

  return {
    id: strId(d._id),
    userId: strId(d.userId),
    orderId: strId(d.orderId),
    status: d.status,

    requestedAt: d.requestedAt || null,
    decidedAt: d.decidedAt || null,
    receivedAt: d.receivedAt || null,
    closedAt: d.closedAt || null,

    customerNote: d.customerNote || "",
    adminNote: d.adminNote || "",

    items: Array.isArray(d.items)
      ? d.items.map((it) => {
          const snapshotCurrency = it.snapshot ? normalizeCurrency(it.snapshot.currency) : null;
          return {
            orderItemId: strId(it.orderItemId),
            variantId: strId(it.variantId),
            quantity: it.quantity,
            action: it.action,
            reasonCode: it.reasonCode || "",
            reasonText: it.reasonText ?? null,
            condition: it.condition ?? null,
            photos: Array.isArray(it.photos) ? it.photos : [],
            snapshot: it.snapshot
              ? {
                  productId: strId(it.snapshot.productId),
                  skuSnapshot: it.snapshot.skuSnapshot || "",
                  nameHeSnapshot: it.snapshot.nameHeSnapshot || "",
                  nameArSnapshot: it.snapshot.nameArSnapshot || "",
                  ...mapMoneyPairFromMinor(
                    Number.isInteger(it.snapshot.unitPrice) ? it.snapshot.unitPrice : 0,
                    snapshotCurrency,
                    "unitPrice",
                    "unitPriceMinor",
                  ),
                  currency: snapshotCurrency,
                }
              : null,
          };
        })
      : [],

    exchange: d.exchange
      ? {
          items: Array.isArray(d.exchange.items)
            ? d.exchange.items.map((x) => ({
                variantId: strId(x.variantId),
                quantity: x.quantity,
              }))
            : [],
          reservationId: strId(d.exchange.reservationId),
          priceDiffMinor: d.exchange.priceDiffMinor ?? null,
        }
      : null,

    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

function returnEligibility(order) {
  const status = String(order?.status || "");
  const eligible = new Set([ORDER_STATUS.FULFILLED, ORDER_STATUS.PARTIALLY_REFUNDED]);
  return { eligible: eligible.has(status), status, allowed: [...eligible] };
}

function snapshotFromOrderItem(order, orderItem, fallbackVariantId) {
  const currency = normalizeCurrency(order?.pricing?.currency || "ILS");
  return {
    productId: orderItem?.productId ? oid(orderItem.productId) : null,
    skuSnapshot: String(orderItem?.skuSnapshot || "").trim(),
    nameHeSnapshot: String(orderItem?.nameHeSnapshot || "").trim(),
    nameArSnapshot: String(orderItem?.nameArSnapshot || "").trim(),
    unitPrice: Number.isInteger(orderItem?.unitPrice) ? orderItem.unitPrice : 0,
    currency,
    _fallbackVariantId: fallbackVariantId ? String(fallbackVariantId) : null,
  };
}

async function computeAlreadyReturnedQty(orderId, { orderItemId, variantId }, session) {
  const rows = await applyQueryBudget(
    ReturnRequest.find({
      orderId: oid(orderId),
      status: { $nin: ["rejected", "canceled"] },
    })
      .select("items")
      .session(session)
      .lean(),
  );

  const wantVariantId = String(variantId || "");
  const wantOrderItemId = String(orderItemId || "");

  const sumBy = (predicate) => {
    let sum = 0;
    for (const r of rows) {
      for (const it of Array.isArray(r.items) ? r.items : []) {
        if (!predicate(it)) continue;
        const q = Number(it?.quantity || 0);
        if (Number.isInteger(q) && q > 0) sum += q;
      }
    }
    return sum;
  };

  if (wantOrderItemId) {
    const byOrderItemId = sumBy((it) => it?.orderItemId && String(it.orderItemId) === wantOrderItemId);
    if (byOrderItemId > 0) return byOrderItemId;
  }

  return sumBy((it) => it?.variantId && String(it.variantId) === wantVariantId);
}

export async function createReturnRequest(userId, payload = {}, ctx = null) {
  const orderId = payload?.orderId;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) throw httpError(400, "INVALID_ITEMS", "items is required");

  const userObjectId = oid(userId, "INVALID_USER_ID");
  const orderObjectId = oid(orderId, "INVALID_ORDER_ID");

  const created = await withRequiredTransaction(async (session) => {
    const order = await applyQueryBudget(
      Order.findOne({ _id: orderObjectId, userId: userObjectId })
        .select("userId status items pricing.currency")
        .session(session)
        .lean(),
    );
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    const eligibility = returnEligibility(order);
    if (!eligibility.eligible) {
      throw httpError(409, "ORDER_NOT_ELIGIBLE_FOR_RETURN", "Order is not eligible for returns", {
        status: eligibility.status,
        allowed: eligibility.allowed,
      });
    }

    const outItems = [];

    for (const it of items) {
      const orderItemId = it?.orderItemId;
      const variantId = it?.variantId;
      const quantity = Number(it?.quantity || 0);

      if (!Types.ObjectId.isValid(String(orderItemId || ""))) {
        throw httpError(400, "INVALID_ORDER_ITEM_ID", "Invalid orderItemId");
      }
      if (!Types.ObjectId.isValid(String(variantId || ""))) {
        throw httpError(400, "INVALID_VARIANT_ID", "Invalid variantId");
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw httpError(400, "INVALID_QUANTITY", "quantity must be a positive integer");
      }

      const orderItems = Array.isArray(order?.items) ? order.items : [];
      const wantOrderItemId = String(orderItemId || "");
      const wantVariantId = String(variantId || "");

      const matchById = orderItems.find((x) => x && x._id && String(x._id) === wantOrderItemId) || null;
      const matchingByVariant = orderItems.filter((x) => x && x.variantId && String(x.variantId) === wantVariantId);
      const match = matchById || matchingByVariant[0] || null;

      if (!match) {
        throw httpError(409, "ORDER_ITEM_NOT_FOUND", "Order item not found on order", {
          orderId: String(orderObjectId),
          orderItemId: String(orderItemId),
          variantId: String(variantId),
        });
      }

      const purchasedQty = matchById
        ? Number(matchById?.quantity || 0)
        : matchingByVariant.reduce((acc, x) => acc + Number(x?.quantity || 0), 0);

      if (!Number.isInteger(purchasedQty) || purchasedQty <= 0) {
        throw httpError(409, "ORDER_ITEM_INVALID_QTY", "Order item quantity is invalid");
      }

      const already = await computeAlreadyReturnedQty(orderObjectId, { orderItemId, variantId }, session);
      if (already + quantity > purchasedQty) {
        throw httpError(409, "RETURN_QUANTITY_EXCEEDS_PURCHASED", "Return quantity exceeds purchased quantity", {
          purchasedQty,
          alreadyRequestedOrReturnedQty: already,
          requestedQty: quantity,
          orderItemId: String(orderItemId),
          variantId: String(variantId),
        });
      }

      const snap = snapshotFromOrderItem(order, match, variantId);
      outItems.push({
        orderItemId: oid(orderItemId),
        variantId: oid(variantId),
        quantity,
        action: String(it?.action || "refund"),
        reasonCode: String(it?.reasonCode || "").trim(),
        reasonText: it?.reasonText !== undefined ? String(it.reasonText || "").trim() || null : null,
        condition: it?.condition !== undefined ? String(it.condition || "").trim() || null : null,
        photos: Array.isArray(it?.photos) ? it.photos.map((u) => String(u)).filter(Boolean).slice(0, 12) : [],
        snapshot: {
          productId: snap.productId,
          skuSnapshot: snap.skuSnapshot,
          nameHeSnapshot: snap.nameHeSnapshot,
          nameArSnapshot: snap.nameArSnapshot,
          unitPrice: snap.unitPrice,
          currency: snap.currency,
        },
      });
    }

    const anyExchange = outItems.some((x) => x.action === "exchange");
    const exchange = payload?.exchange && typeof payload.exchange === "object" ? payload.exchange : null;

    const doc = await ReturnRequest.create(
      [
        {
          userId: userObjectId,
          orderId: orderObjectId,
          items: outItems,
          status: "requested",
          requestedAt: new Date(),
          customerNote: payload?.customerNote ? String(payload.customerNote).trim() : "",
          exchange: anyExchange
            ? {
                items: Array.isArray(exchange?.items)
                  ? exchange.items.map((x) => ({
                      variantId: oid(x.variantId, "INVALID_EXCHANGE_VARIANT_ID"),
                      quantity: Number(x.quantity || 0),
                    }))
                  : [],
                reservationId: null,
                priceDiffMinor:
                  exchange?.priceDiffMinor === undefined || exchange?.priceDiffMinor === null
                    ? null
                    : Number(exchange.priceDiffMinor),
              }
            : null,
        },
      ],
      { session },
    );

    return doc?.[0] || null;
  });

  return toReturnDTO(created);
}

export async function listMyReturns({ userId, page, limit, status } = {}) {
  const p = parsePagination({ page, limit }, { maxLimit: 100, defaultLimit: 20 });
  const userObjectId = oid(userId, "INVALID_USER_ID");

  const filter = { userId: userObjectId };
  if (status) filter.status = String(status);

  const [items, total] = await Promise.all([
    applyQueryBudget(
      ReturnRequest.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
    ),
    applyQueryBudget(ReturnRequest.countDocuments(filter)),
  ]);

  return {
    page: p.page,
    limit: p.limit,
    total,
    items: items.map(toReturnDTO),
  };
}

export async function getMyReturn({ userId, id }) {
  const userObjectId = oid(userId, "INVALID_USER_ID");
  const doc = await applyQueryBudget(
    ReturnRequest.findOne({ _id: oid(id, "INVALID_RETURN_ID"), userId: userObjectId }).lean(),
  );
  if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");
  return toReturnDTO(doc);
}

export async function cancelReturn(userId, id) {
  const userObjectId = oid(userId, "INVALID_USER_ID");
  const returnId = oid(id, "INVALID_RETURN_ID");

  const updated = await withRequiredTransaction(async (session) => {
    const doc = await applyQueryBudget(
      ReturnRequest.findOne({ _id: returnId, userId: userObjectId }).session(session),
    );
    if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");
    if (doc.status !== "requested") {
      throw httpError(409, "RETURN_CANCEL_NOT_ALLOWED", "Only requested returns can be canceled", {
        status: doc.status,
      });
    }

    doc.status = "canceled";
    doc.closedAt = new Date();
    await doc.save({ session });
    return doc;
  });

  return toReturnDTO(updated);
}

export async function adminListReturns({ q = {}, ctx = null } = {}) {
  const p = parseAdminPagination(q, { defaultLimit: 20, maxLimit: 200 });
  const sort = parseSort(q.sort, ["createdAt", "status", "requestedAt", "decidedAt", "receivedAt", "closedAt"], {
    defaultSort: { createdAt: -1, _id: -1 },
  });

  const filter = {};
  if (q.status) filter.status = String(q.status);
  if (q.userId) filter.userId = oid(q.userId, "INVALID_USER_ID");
  if (q.orderId) filter.orderId = oid(q.orderId, "INVALID_ORDER_ID");

  const search = buildSearchOrFilter(q.q, ["customerNote", "adminNote"]);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    applyQueryBudget(
      ReturnRequest.find(filter)
        .sort(sort)
        .skip(p.skip)
        .limit(p.limit)
        .lean(),
    ),
    applyQueryBudget(ReturnRequest.countDocuments(filter)),
  ]);

  return buildListEnvelope({
    items: items.map(toReturnDTO),
    page: p.page,
    limit: p.limit,
    total,
  });
}

export async function adminGetReturn(id) {
  const doc = await applyQueryBudget(ReturnRequest.findById(oid(id, "INVALID_RETURN_ID")).lean());
  if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");
  return toReturnDTO(doc);
}

export async function adminDecide(id, { decision, note } = {}, ctx = null) {
  const returnId = oid(id, "INVALID_RETURN_ID");
  const op = String(decision || "");
  if (!["approve", "reject"].includes(op)) throw httpError(400, "INVALID_DECISION", "decision must be approve|reject");

  const updated = await withRequiredTransaction(async (session) => {
    const doc = await applyQueryBudget(ReturnRequest.findById(returnId).session(session));
    if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");

    if (doc.status !== "requested") {
      throw httpError(409, "RETURN_DECISION_NOT_ALLOWED", "Return decision not allowed in current status", {
        status: doc.status,
      });
    }

    const now = new Date();
    doc.decidedAt = now;
    doc.adminNote = note ? String(note).trim() : doc.adminNote || "";

    if (op === "reject") {
      doc.status = "rejected";
      doc.closedAt = now;
      await doc.save({ session });
      return doc;
    }

    // approve
    doc.status = "approved";

    const exchangeItems = Array.isArray(doc.exchange?.items) ? doc.exchange.items : [];
    if (exchangeItems.length) {
      // Reserve replacement stock group by returnId (reuses proven stock reservation flow)
      await reserveStock(returnId, exchangeItems, {
        session,
        requireActive: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      });
      doc.exchange.reservationId = returnId;
    }

    await doc.save({ session });
    return doc;
  });

  return toReturnDTO(updated);
}

export async function adminMarkReceived(id, { note } = {}, ctx = null) {
  const returnId = oid(id, "INVALID_RETURN_ID");

  const updated = await withRequiredTransaction(async (session) => {
    const doc = await applyQueryBudget(ReturnRequest.findById(returnId).session(session));
    if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");

    if (doc.status !== "approved") {
      throw httpError(409, "RETURN_RECEIVE_NOT_ALLOWED", "Return cannot be marked received in current status", {
        status: doc.status,
      });
    }

    // Restore stock only when received (never before).
    const restockItems = Array.isArray(doc.items)
      ? doc.items.map((it) => ({ variantId: it.variantId, quantity: it.quantity }))
      : [];

    if (restockItems.length) {
      await refundRestoreStockBulk(doc.orderId, restockItems, {
        mode: "return_received",
        returnId: String(returnId),
        actorId: ctx?.actorId || null,
        roles: normalizeRoles(ctx?.roles),
      }, { session });
    }

    const now = new Date();
    doc.status = "received";
    doc.receivedAt = now;
    if (note !== undefined) doc.adminNote = String(note || "").trim();
    await doc.save({ session });
    return doc;
  });

  return toReturnDTO(updated);
}

export async function adminClose(id, { status, note } = {}, ctx = null) {
  const returnId = oid(id, "INVALID_RETURN_ID");
  const next = String(status || "");
  if (!["refunded", "exchanged", "canceled"].includes(next)) {
    throw httpError(400, "INVALID_CLOSE_STATUS", "status must be refunded|exchanged|canceled");
  }

  const updated = await withRequiredTransaction(async (session) => {
    const doc = await applyQueryBudget(ReturnRequest.findById(returnId).session(session));
    if (!doc) throw httpError(404, "RETURN_NOT_FOUND", "Return request not found");

    const now = new Date();

    const exchangeItems = Array.isArray(doc.exchange?.items) ? doc.exchange.items : [];
    const hasReservedExchange = !!doc.exchange?.reservationId && exchangeItems.length > 0;

    // Close rules
    if (next === "refunded") {
      if (doc.status !== "received") {
        throw httpError(409, "RETURN_CLOSE_NOT_ALLOWED", "Return can be refunded only after received", {
          status: doc.status,
        });
      }

      // If reserved exchange exists but we're refunding, release it.
      if (hasReservedExchange) {
        await releaseReservedStockBulk(returnId, exchangeItems, "return_refunded", { session });
        doc.exchange.reservationId = null;
      }

      doc.status = "refunded";
      doc.closedAt = now;
      if (note !== undefined) doc.adminNote = String(note || "").trim();
      await doc.save({ session });
      return doc;
    }

    if (next === "exchanged") {
      if (doc.status !== "received") {
        throw httpError(409, "RETURN_CLOSE_NOT_ALLOWED", "Return can be exchanged only after received", {
          status: doc.status,
        });
      }
      if (!hasReservedExchange) {
        throw httpError(409, "EXCHANGE_RESERVATION_REQUIRED", "Exchange reservation is required before exchanging");
      }

      // Confirm reserved replacement stock at finalize.
      await confirmStock(returnId, exchangeItems, { session, requireActive: true, allowLegacy: false });

      doc.status = "exchanged";
      doc.closedAt = now;
      if (note !== undefined) doc.adminNote = String(note || "").trim();
      await doc.save({ session });
      return doc;
    }

    // canceled
    if (!["requested", "approved", "received"].includes(doc.status)) {
      throw httpError(409, "RETURN_CLOSE_NOT_ALLOWED", "Return cannot be canceled in current status", {
        status: doc.status,
      });
    }

    if (hasReservedExchange) {
      await releaseReservedStockBulk(returnId, exchangeItems, "return_canceled", { session });
      doc.exchange.reservationId = null;
    }

    doc.status = "canceled";
    doc.closedAt = now;
    if (note !== undefined) doc.adminNote = String(note || "").trim();
    await doc.save({ session });
    return doc;
  });

  return toReturnDTO(updated);
}
