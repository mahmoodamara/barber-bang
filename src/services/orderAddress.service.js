import mongoose from "mongoose";

import { Order } from "../models/Order.js";
import { User } from "../models/User.js";
import { ShippingMethod } from "../models/ShippingMethod.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { repriceOrder } from "./reprice.service.js";

const { Types } = mongoose;

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function ensureEditableStatus(order) {
  const status = String(order?.status || "");
  if (status === "draft" || status === "pending_payment") return;
  throw httpError(409, "ORDER_NOT_EDITABLE", "Order must be draft or pending_payment", { status });
}

function s(v, max, fallback = "") {
  const raw = v === null || v === undefined ? "" : String(v);
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeAddressSnapshotInput(a) {
  if (!a || typeof a !== "object") return null;
  return {
    fullName: s(a.fullName, 120, ""),
    phone: s(a.phone, 30, ""),
    country: s(a.country, 80, ""),
    city: s(a.city, 120, ""),
    street: s(a.street, 200, ""),
    building: s(a.building, 50, ""),
    apartment: s(a.apartment, 50, ""),
    zip: s(a.zip ?? a.postalCode, 30, ""),
    notes: s(a.notes, 500, ""),
  };
}

function normalizeCity(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeCities(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const set = new Set(list.map(normalizeCity).filter(Boolean));
  return Array.from(set).slice(0, 500);
}

function normalizeNullableMinor(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function matchCity(method, city) {
  const list = Array.isArray(method.cities) ? method.cities : [];
  if (!list.length) return true;
  const c = normalizeCity(city);
  if (!c) return false;
  return list.some((x) => normalizeCity(x) === c);
}

function isEligible(method, payableSubtotalMinor, city) {
  if (!method?.isActive) return false;

  const minSubtotal = normalizeNullableMinor(method.minSubtotal);
  const maxSubtotal = normalizeNullableMinor(method.maxSubtotal);
  if (minSubtotal !== null && payableSubtotalMinor < minSubtotal) return false;
  if (maxSubtotal !== null && payableSubtotalMinor > maxSubtotal) return false;

  if (!matchCity(method, city)) return false;
  return true;
}

function payableSubtotalMinor(order) {
  const subtotal = Number(order?.pricing?.subtotal ?? 0);
  const discount = Number(order?.pricing?.discountTotal ?? 0);
  if (!Number.isInteger(subtotal) || subtotal < 0) return 0;
  if (!Number.isInteger(discount) || discount < 0) return Math.max(0, subtotal);
  return Math.max(0, subtotal - discount);
}

async function resolveUserAddressSnapshot({ userId, addressId }) {
  const user = await applyQueryBudget(User.findById(userId).select("addresses").lean());
  if (!user) throw httpError(404, "USER_NOT_FOUND", "User not found");

  const found = Array.isArray(user.addresses)
    ? user.addresses.find((a) => String(a?._id) === String(addressId))
    : null;

  if (!found) throw httpError(404, "ADDRESS_NOT_FOUND", "Address not found");
  return normalizeAddressSnapshotInput(found);
}

/**
 * updateOrderAddresses
 *
 * - Owner-only (userId filter)
 * - Editable orders only (draft/pending_payment)
 * - Any shipping/billing address change triggers repriceOrder (tax snapshot refresh)
 * - If chosen shipping method becomes ineligible (e.g. city change), it is cleared.
 */
export async function updateOrderAddresses({ orderId, userId, patch = {} } = {}) {
  if (!orderId) throw httpError(400, "ORDER_ID_REQUIRED", "orderId is required");
  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");

  return await withRequiredTransaction(async (session) => {
    const order = await applyQueryBudget(
      Order.findOne({ _id: orderId, userId }).session(session),
    );
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    ensureEditableStatus(order);

    const shippingAddressId = patch?.shippingAddressId ? String(patch.shippingAddressId) : null;
    const billingAddressId = patch?.billingAddressId ? String(patch.billingAddressId) : null;

    const hasShipping = Object.prototype.hasOwnProperty.call(patch || {}, "shippingAddress") || shippingAddressId;
    const hasBilling = Object.prototype.hasOwnProperty.call(patch || {}, "billingAddress") || billingAddressId;
    if (!hasShipping && !hasBilling) {
      throw httpError(400, "ADDRESS_PATCH_REQUIRED", "Provide shippingAddress/billingAddress or addressId");
    }

    if (hasShipping) {
      if (shippingAddressId) {
        order.shippingAddress = await resolveUserAddressSnapshot({ userId, addressId: shippingAddressId });
      } else if (patch?.shippingAddress === null) {
        order.shippingAddress = null;
      } else {
        order.shippingAddress = normalizeAddressSnapshotInput(patch?.shippingAddress);
      }
    }

    if (hasBilling) {
      if (billingAddressId) {
        order.billingAddress = await resolveUserAddressSnapshot({ userId, addressId: billingAddressId });
      } else if (patch?.billingAddress === null) {
        order.billingAddress = null;
      } else {
        order.billingAddress = normalizeAddressSnapshotInput(patch?.billingAddress);
      }
    }

    // If shipping city changed, a previously selected shippingMethod might become invalid.
    if (order.shippingMethod?.shippingMethodId) {
      const smId = String(order.shippingMethod.shippingMethodId);
      if (Types.ObjectId.isValid(smId)) {
        const method = await ShippingMethod.findById(smId).session(session).lean();
        if (!method || !method.isActive) {
          order.shippingMethod = null;
          order.pricing = order.pricing || {};
          order.pricing.shipping = 0;
        } else {
          method.cities = normalizeCities(method.cities);
          const city = order?.shippingAddress?.city || "";
          const payable = payableSubtotalMinor(order);
          if (!isEligible(method, payable, city)) {
            order.shippingMethod = null;
            order.pricing = order.pricing || {};
            order.pricing.shipping = 0;
          }
        }
      }
    }

    await order.save({ session });
    await repriceOrder(order._id, { session });

    const updated = await applyQueryBudget(Order.findById(order._id).session(session).lean());
    if (!updated) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
    return updated;
  });
}

