// src/services/shipping.service.js
import mongoose from "mongoose";
import { ShippingMethod, Order } from "../models/index.js";
import { ENV } from "../utils/env.js";
import { assertIntMinor, mapMoneyPairFromMinor, normalizeCurrency } from "../utils/money.js";
import { formatOrderForResponse } from "../utils/orderResponse.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { repriceOrder } from "./reprice.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

// ✅ Owner-only (no staff/admin bypass in USER flows)
function ensureOwnerOnly(order, auth) {
  if (order.userId && auth?.userId && String(order.userId) === String(auth.userId)) return;
  throw httpError(403, "FORBIDDEN", "Not allowed");
}

function ensureIntMinor(v, field) {
  if (v === null || v === undefined) {
    throw httpError(400, "INVALID_MONEY_UNIT", `${field} must be integer (minor units) >= 0`);
  }
  assertIntMinor(v, field);
}

function normalizeNullableMinor(v, field) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw httpError(400, "INVALID_MONEY_UNIT", `${field} must be integer (minor units) >= 0`);
  }
  return n;
}

function computePayableSubtotal(order) {
  const subtotal = order?.pricing?.subtotal ?? 0;
  const discount = order?.pricing?.discountTotal ?? 0;
  ensureIntMinor(subtotal, "pricing.subtotal");
  ensureIntMinor(discount, "pricing.discountTotal");
  return Math.max(0, subtotal - discount);
}

function normalizeCity(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeCities(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const set = new Set(list.map(normalizeCity).filter(Boolean));
  return Array.from(set).slice(0, 500);
}

function matchCity(method, city) {
  const list = Array.isArray(method.cities) ? method.cities : [];
  if (!list.length) return true;
  const c = normalizeCity(city);
  if (!c) return false;
  return list.some((x) => normalizeCity(x) === c);
}

function isEligible(method, payableSubtotal, city) {
  if (!method?.isActive) return false;

  const minSubtotal = normalizeNullableMinor(method.minSubtotal, "minSubtotal");
  const maxSubtotal = normalizeNullableMinor(method.maxSubtotal, "maxSubtotal");
  if (minSubtotal !== null && payableSubtotal < minSubtotal) return false;
  if (maxSubtotal !== null && payableSubtotal > maxSubtotal) return false;

  if (!matchCity(method, city)) return false;

  return true;
}

function computeShippingPrice(method, payableSubtotal) {
  const freeAbove = normalizeNullableMinor(method.freeAbove, "freeAbove");
  if (freeAbove !== null && payableSubtotal >= freeAbove) return 0;
  return normalizeNullableMinor(method.basePrice, "basePrice") || 0;
}

function localize(method, lang, payableSubtotal, city) {
  const basePrice = normalizeNullableMinor(method.basePrice, "basePrice");
  const freeAbove = normalizeNullableMinor(method.freeAbove, "freeAbove");
  const minSubtotal = normalizeNullableMinor(method.minSubtotal, "minSubtotal");
  const maxSubtotal = normalizeNullableMinor(method.maxSubtotal, "maxSubtotal");
  const currency = normalizeCurrency(ENV.STRIPE_CURRENCY) || "ILS";
  const computedPriceMinor = computeShippingPrice({ ...method, basePrice, freeAbove }, payableSubtotal);

  return {
    id: String(method._id),
    code: method.code,
    name: lang === "ar" ? method.nameAr : method.nameHe,
    desc: lang === "ar" ? method.descAr : method.descHe,
    ...mapMoneyPairFromMinor(basePrice, currency, "basePrice", "basePriceMinor"),
    ...mapMoneyPairFromMinor(freeAbove, currency, "freeAbove", "freeAboveMinor"),
    ...mapMoneyPairFromMinor(minSubtotal, currency, "minSubtotal", "minSubtotalMinor"),
    ...mapMoneyPairFromMinor(maxSubtotal, currency, "maxSubtotal", "maxSubtotalMinor"),
    sort: method.sort,
    eligible: isEligible({ ...method, minSubtotal, maxSubtotal }, payableSubtotal, city),
    ...mapMoneyPairFromMinor(computedPriceMinor, currency, "computedPrice", "computedPriceMinor"),
    currency,
  };
}

/**
 * Public listing (no auth)
 */
export async function listShippingMethodsPublic({ lang = "he", payableSubtotal = 0, city }) {
  ensureIntMinor(payableSubtotal, "payableSubtotal");

  const methods = await ShippingMethod.find({ isActive: true })
    .select(
      "code nameHe nameAr descHe descAr basePrice freeAbove minSubtotal maxSubtotal cities sort isActive",
    )
    .sort({ sort: 1, createdAt: -1 })
    .lean();

  return methods.map((m) => localize(m, lang, payableSubtotal, city)).filter((m) => m.eligible);
}

/**
 * USER flow: list shipping methods for an order (owner-only)
 */
export async function listShippingMethodsForOrder({ orderId, auth, lang = "he" }) {
  const order = await Order.findById(orderId)
    .select("userId status pricing shippingAddress.city")
    .lean();

  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  // ✅ owner-only: remove staff/admin bypass from user routes
  ensureOwnerOnly(order, auth);

  const payableSubtotal = computePayableSubtotal(order);
  const currency =
    normalizeCurrency(order?.pricing?.currency) ||
    normalizeCurrency(ENV.STRIPE_CURRENCY) ||
    "ILS";

  const city = order?.shippingAddress?.city || "";

  const methods = await listShippingMethodsPublic({ lang, payableSubtotal, city });

  return {
    methods,
    ...mapMoneyPairFromMinor(payableSubtotal, currency, "payableSubtotal", "payableSubtotalMinor"),
    currency,
    city,
  };
}

/**
 * USER flow: set shipping method for an order (owner-only)
 * Admin/staff must not use this from user endpoints; they should use dedicated Admin endpoints/services.
 */
export async function setOrderShippingMethod({
  orderId,
  auth,
  shippingMethodId,
  lang: _lang = "he",
  options = {},
}) {
  const session = options.session;
  if (!session) {
    return await withRequiredTransaction(async (s) => {
      return await setOrderShippingMethod({
        orderId,
        auth,
        shippingMethodId,
        lang: _lang,
        options: { ...(options || {}), session: s },
      });
    });
  }

  const order = await Order.findById(orderId).session(session);
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

  // ✅ owner-only: remove staff/admin bypass
  ensureOwnerOnly(order, auth);

  if (!["draft", "pending_payment"].includes(order.status)) {
    throw httpError(409, "ORDER_NOT_EDITABLE", "Order must be draft or pending_payment");
  }

  const method = await ShippingMethod.findById(shippingMethodId).session(session).lean();
  if (!method || !method.isActive) {
    throw httpError(404, "SHIPPING_METHOD_NOT_FOUND", "Shipping method not found");
  }

  method.cities = normalizeCities(method.cities);

  const payableSubtotal = computePayableSubtotal(order);
  const city = order?.shippingAddress?.city || "";

  if (!isEligible(method, payableSubtotal, city)) {
    throw httpError(409, "SHIPPING_METHOD_NOT_ELIGIBLE", "Shipping method is not eligible for this order", {
      payableSubtotal,
      city,
    });
  }

  const computedPrice = computeShippingPrice(method, payableSubtotal);

  order.shippingMethod = {
    shippingMethodId: new mongoose.Types.ObjectId(method._id),
    code: method.code,
    nameHeSnapshot: method.nameHe,
    nameArSnapshot: method.nameAr,
    basePriceSnapshot: normalizeNullableMinor(method.basePrice, "basePrice"),
    freeAboveSnapshot: normalizeNullableMinor(method.freeAbove, "freeAbove"),
    computedPrice,
  };

  order.pricing = order.pricing || {};
  order.pricing.shipping = computedPrice;

  await order.save({ session });
  await repriceOrder(order._id, { session });

  const updated = await Order.findById(order._id).session(session).lean();
  const formatted = formatOrderForResponse(updated || (order.toJSON ? order.toJSON() : order));
  if (formatted?.shippingMethod && updated?.shippingMethod) {
    formatted.shippingMethod = {
      ...formatted.shippingMethod,
      computedPriceMinor: updated.shippingMethod.computedPrice,
    };
  }

  return formatted;
}

/**
 * --------------------------------------------------------------------
 * Admin-only operations MUST be exposed via new Admin endpoints/services
 * --------------------------------------------------------------------
 *
 * Example plan (do not wire to user routes):
 * - adminListShippingMethods({ includeInactive, ... })
 * - adminCreateShippingMethod(payload)
 * - adminUpdateShippingMethod(id, patch)
 * - adminDeactivateShippingMethod(id)
 * - adminSetOrderShippingMethod({ orderId, shippingMethodId, actorId, ctx })
 *
 * Keep them separate to avoid privilege bleed into user flows.
 */
