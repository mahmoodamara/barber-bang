import mongoose from "mongoose";

import { Order } from "../models/Order.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withOptionalTransaction } from "../utils/mongoTx.js";
import { computeTax } from "./tax.service.js";
import {
  buildPromotionSnapshot,
  evaluatePromotions,
  fetchPromotionsForPricing,
  releasePromotionsForOrder,
  reservePromotionsForOrder,
  selectPromotions,
} from "./promotion.service.js";

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

function ensureMinorInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(500, "INVALID_MONEY_UNIT", `${field} must be int >= 0`);
  return n;
}

function isEditableStatus(status) {
  return status === "draft" || status === "pending_payment";
}

function computeSubtotalFromItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  let subtotal = 0;

  for (const it of items) {
    const unitPrice = ensureMinorInt(it?.unitPrice ?? 0, "items[].unitPrice");
    const qty = Number(it?.quantity ?? 0);
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, "INVALID_QUANTITY", "Invalid item quantity");

    const expectedLine = unitPrice * qty;
    it.lineTotal = expectedLine;
    subtotal += expectedLine;
  }

  return ensureMinorInt(subtotal, "pricing.subtotal");
}

function computeShippingMinor(order) {
  const fromSnap = order?.shippingMethod?.computedPrice;
  if (Number.isInteger(fromSnap) && fromSnap >= 0) return fromSnap;
  return ensureMinorInt(order?.pricing?.shipping ?? 0, "pricing.shipping");
}

function computeCouponDiscountMinor(order, subtotal) {
  const raw = order?.coupon?.discountTotal ?? 0;
  const discount = ensureMinorInt(raw, "coupon.discountTotal");
  if (discount > subtotal && subtotal > 0) {
    throw httpError(409, "DISCOUNT_EXCEEDS_SUBTOTAL", "Discount exceeds subtotal");
  }
  return discount;
}

async function buildPromotionItems(order, session) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const productIds = [
    ...new Set(items.map((it) => String(it?.productId || "")).filter(Boolean)),
  ];

  const products = productIds.length
    ? await applyQueryBudget(
        Product.find({ _id: { $in: productIds } })
          .select("brand categoryIds")
          .session(session)
          .lean(),
      )
    : [];

  const productMap = new Map(products.map((p) => [String(p._id), p]));

  return items.map((it) => {
    const prod = productMap.get(String(it?.productId || "")) || {};
    return {
      productId: it?.productId || null,
      categoryIds: Array.isArray(prod.categoryIds) ? prod.categoryIds : [],
      brand: prod.brand || null,
      quantity: Number(it?.quantity || 0),
      unitPriceMinor: ensureMinorInt(it?.unitPrice ?? 0, "items[].unitPrice"),
      lineSubtotalMinor: ensureMinorInt(it?.lineTotal ?? 0, "items[].lineTotal"),
    };
  });
}

async function loadUserContext(order, session, ctx) {
  const ctxRoles = Array.isArray(ctx?.roles) ? ctx.roles : [];
  const ctxSegments = Array.isArray(ctx?.segments) ? ctx.segments : [];
  if (ctxRoles.length || ctxSegments.length) {
    return {
      userId: order.userId || null,
      roles: ctxRoles,
      segments: ctxSegments,
    };
  }

  if (!order?.userId) return { userId: null, roles: [], segments: [] };

  const user = await applyQueryBudget(
    User.findById(order.userId).select("roles segments").session(session).lean(),
  );
  return {
    userId: order.userId || null,
    roles: Array.isArray(user?.roles) ? user.roles : [],
    segments: Array.isArray(user?.segments) ? user.segments : [],
  };
}

function setPricingTaxSnapshots(order, taxOut) {
  order.pricing = order.pricing || {};
  order.pricing.taxMinor = ensureMinorInt(taxOut.taxMinor ?? 0, "pricing.taxMinor");
  order.pricing.tax = order.pricing.taxMinor; // legacy mirror
  order.pricing.taxRateBps = Number.isInteger(taxOut.taxRateBps) ? taxOut.taxRateBps : 0;
  order.pricing.taxBasisMinor = ensureMinorInt(taxOut.taxBasisMinor ?? 0, "pricing.taxBasisMinor");
  order.pricing.taxCountrySnapshot = taxOut.taxCountrySnapshot || null;
  order.pricing.taxCitySnapshot = taxOut.taxCitySnapshot || null;
}

function setPricingTotals(order, { subtotal, discount, shipping, tax }) {
  order.pricing = order.pricing || {};
  order.pricing.subtotal = subtotal;
  order.pricing.discountTotal = discount;
  order.pricing.shipping = shipping;
  order.pricing.taxMinor = tax;
  order.pricing.tax = tax; // legacy mirror
  order.pricing.grandTotal = Math.max(0, subtotal - discount + shipping + tax);
}

/**
 * repriceOrder (Source of truth)
 *
 * Recomputes and persists:
 * - subtotalMinor, discountTotalMinor, shippingMinor, taxMinor, grandTotalMinor
 *
 * Notes:
 * - currency is unchanged
 * - requires order to be editable (draft/pending_payment)
 * - uses pricing.taxMinor as canonical; pricing.tax mirrors it
 */
export async function repriceOrder(orderId, { session = null, ctx = null } = {}) {
  const id = oid(orderId, "INVALID_ORDER_ID");

  const work = async (s) => {
    const order = await applyQueryBudget(Order.findById(id).session(s));
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    if (!isEditableStatus(order.status)) {
      throw httpError(409, "ORDER_NOT_EDITABLE", "Order cannot be repriced in its current status", {
        status: order.status,
      });
    }

    // Subtotal from immutable item snapshots (unitPrice/quantity)
    const subtotal = computeSubtotalFromItems(order);

    // Discount from coupon snapshot
    const couponDiscount = computeCouponDiscountMinor(order, subtotal);

    // Shipping from shipping snapshot
    const shipping = computeShippingMinor(order);

    const promoItems = await buildPromotionItems(order, s);
    const userCtx = await loadUserContext(order, s, ctx);
    const promoCode = order?.promotionCode ? String(order.promotionCode).trim().toUpperCase() : null;

    const promotions = await fetchPromotionsForPricing({ code: promoCode, now: new Date(), session: s });
    const evaluated = evaluatePromotions({
      promotions,
      ctx: {
        user: userCtx,
        items: promoItems,
        subtotalMinor: subtotal,
        shippingMinor: shipping,
        city: order?.shippingAddress?.city || "",
        code: promoCode,
      },
    });

    const selected = selectPromotions(evaluated);
    const selectedIds = new Set(selected.map((x) => String(x?.promotion?._id || "")));
    const existingIds = new Set(
      Array.isArray(order.promotions) ? order.promotions.map((p) => String(p?.promotionId || "")) : [],
    );

    const toRelease = [];
    for (const idStr of existingIds) {
      if (idStr && !selectedIds.has(idStr)) toRelease.push(idStr);
    }

    if (toRelease.length) {
      await releasePromotionsForOrder({ orderId: order._id, promotionIds: toRelease, session: s });
    }

    if (selected.length) {
      await reservePromotionsForOrder({
        orderId: order._id,
        userId: userCtx.userId,
        promotionsApplied: selected,
        session: s,
      });
    }

    const promotionSnapshots = selected.map(buildPromotionSnapshot);
    const maxPromoDiscount = Math.max(0, subtotal - couponDiscount);
    let promotionsDiscount = 0;
    for (const snap of promotionSnapshots) {
      if (promotionsDiscount >= maxPromoDiscount) {
        snap.discountMinor = 0;
        continue;
      }
      const next = promotionsDiscount + (snap.discountMinor || 0);
      if (next > maxPromoDiscount) {
        snap.discountMinor = maxPromoDiscount - promotionsDiscount;
        promotionsDiscount = maxPromoDiscount;
        continue;
      }
      promotionsDiscount = next;
    }

    order.promotions = promotionSnapshots;
    order.pricing = order.pricing || {};
    order.pricing.discountBreakdown = {
      couponMinor: couponDiscount,
      promotionsMinor: promotionsDiscount,
    };

    const discount = Math.min(subtotal, couponDiscount + promotionsDiscount);

    const taxOut = computeTax({
      itemsSubtotalMinor: subtotal,
      discountMinor: discount,
      shippingMinor: shipping,
      shippingAddress: order.shippingAddress,
    });

    setPricingTaxSnapshots(order, taxOut);
    setPricingTotals(order, { subtotal, discount, shipping, tax: order.pricing.taxMinor });

    await order.save({ session: s });

    return {
      orderId: String(order._id),
      currency: String(order.pricing?.currency || "ILS"),
      subtotalMinor: subtotal,
      discountTotalMinor: discount,
      shippingMinor: shipping,
      taxMinor: order.pricing.taxMinor,
      grandTotalMinor: order.pricing.grandTotal,
      taxRateBps: order.pricing.taxRateBps || 0,
      taxBasisMinor: order.pricing.taxBasisMinor || 0,
      taxCountrySnapshot: order.pricing.taxCountrySnapshot || null,
      taxCitySnapshot: order.pricing.taxCitySnapshot || null,
      meta: ctx ? { requestId: ctx?.requestId || null } : undefined,
    };
  };

  if (session) return await work(session);
  return await withOptionalTransaction(work);
}
