import { Order } from "../models/Order.js";
import { ShippingMethod } from "../models/ShippingMethod.js";
import { withOptionalTransaction } from "../utils/mongoTx.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { normalizeCurrency } from "../utils/money.js";
import { computeTax } from "./tax.service.js";
import { repriceOrder } from "./reprice.service.js";

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
  throw httpError(409, "ORDER_NOT_EDITABLE", "Order is not editable", { status });
}

function ensureIntMinor(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(500, "INVALID_MONEY_UNIT", `${field} must be int >= 0`);
  return n;
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
  if (!list.length) return { ok: true, reason: null };
  const c = normalizeCity(city);
  if (!c) return { ok: false, reason: "CITY_REQUIRED" };
  return list.some((x) => normalizeCity(x) === c)
    ? { ok: true, reason: null }
    : { ok: false, reason: "CITY_NOT_SUPPORTED" };
}

function normalizeNullableMinor(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function computeShippingPriceMinor(method, payableSubtotalMinor) {
  const basePrice = normalizeNullableMinor(method.basePrice) ?? 0;
  const freeAbove = normalizeNullableMinor(method.freeAbove);
  if (freeAbove !== null && payableSubtotalMinor >= freeAbove) return 0;
  return basePrice;
}

function eligibilityWithReasons(method, { payableSubtotalMinor, city }) {
  const reasons = [];
  if (!method?.isActive) reasons.push("INACTIVE");

  const minSubtotal = normalizeNullableMinor(method.minSubtotal);
  const maxSubtotal = normalizeNullableMinor(method.maxSubtotal);

  if (minSubtotal !== null && payableSubtotalMinor < minSubtotal) reasons.push("SUBTOTAL_BELOW_MIN");
  if (maxSubtotal !== null && payableSubtotalMinor > maxSubtotal) reasons.push("SUBTOTAL_ABOVE_MAX");

  const cityCheck = matchCity(method, city);
  if (!cityCheck.ok && cityCheck.reason) reasons.push(cityCheck.reason);

  return { eligible: reasons.length === 0, reasons };
}

function computeTotalsForShipping({ subtotalMinor, discountMinor, shippingMinor, shippingAddress }) {
  const taxOut = computeTax({
    itemsSubtotalMinor: subtotalMinor,
    discountMinor,
    shippingMinor,
    shippingAddress,
  });

  const taxMinor = ensureIntMinor(taxOut.taxMinor ?? 0, "taxMinor");
  const grandTotalMinor = Math.max(0, subtotalMinor - discountMinor + shippingMinor + taxMinor);

  return {
    subtotalMinor,
    discountTotalMinor: discountMinor,
    shippingMinor,
    taxMinor,
    grandTotalMinor,
    taxRateBps: Number.isInteger(taxOut.taxRateBps) ? taxOut.taxRateBps : 0,
    taxBasisMinor: ensureIntMinor(taxOut.taxBasisMinor ?? 0, "taxBasisMinor"),
    taxCountrySnapshot: taxOut.taxCountrySnapshot ?? null,
    taxCitySnapshot: taxOut.taxCitySnapshot ?? null,
  };
}

/**
 * quoteOrder (Checkout Contract)
 *
 * Returns:
 * - shipping methods (eligible + reasons for ineligibility)
 * - computed totals for each shipping method option
 * - current order pricing snapshots (minor units)
 *
 * Notes:
 * - Owner-only (uses userId filter)
 * - Reprices order (source of truth) while still editable
 */
export async function quoteOrder({ orderId, userId, lang = "he" } = {}) {
  if (!orderId) throw httpError(400, "ORDER_ID_REQUIRED", "orderId is required");
  if (!userId) throw httpError(401, "UNAUTHORIZED", "Authentication required");

  return await withOptionalTransaction(async (session) => {
    const order = await applyQueryBudget(
      Order.findOne({ _id: orderId, userId }).session(session),
    );
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    ensureEditableStatus(order);

    await repriceOrder(order._id, { session });

    const fresh = await applyQueryBudget(Order.findById(order._id).session(session).lean());
    if (!fresh) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    const subtotalMinor = ensureIntMinor(fresh?.pricing?.subtotal ?? 0, "pricing.subtotal");
    const discountMinor = ensureIntMinor(fresh?.pricing?.discountTotal ?? 0, "pricing.discountTotal");
    const discountBreakdown = fresh?.pricing?.discountBreakdown || {};
    const payableSubtotalMinor = Math.max(0, subtotalMinor - discountMinor);

    const city = fresh?.shippingAddress?.city || "";

    const methods = await applyQueryBudget(
      ShippingMethod.find({ isActive: true })
        .select(
          "code nameHe nameAr descHe descAr basePrice freeAbove minSubtotal maxSubtotal cities sort isActive",
        )
        .sort({ sort: 1, createdAt: -1 })
        .session(session)
        .lean(),
    );

    const shippingMethods = methods.map((m) => {
      m.cities = normalizeCities(m.cities);
      const { eligible, reasons } = eligibilityWithReasons(m, { payableSubtotalMinor, city });
      const computedPriceMinor = computeShippingPriceMinor(m, payableSubtotalMinor);
      return {
        id: String(m._id),
        code: m.code,
        name: lang === "ar" ? m.nameAr : m.nameHe,
        desc: lang === "ar" ? m.descAr : m.descHe,
        sort: m.sort,
        eligible,
        ineligibleReasons: reasons,
        computedPriceMinor,
        totalsMinor: computeTotalsForShipping({
          subtotalMinor,
          discountMinor,
          shippingMinor: computedPriceMinor,
          shippingAddress: fresh.shippingAddress,
        }),
      };
    });

    const currency = normalizeCurrency(fresh?.pricing?.currency || "ILS");

    return {
      orderId: String(fresh._id),
      status: fresh.status,
      currency,
      shippingAddress: fresh.shippingAddress || null,
      billingAddress: fresh.billingAddress || null,
      selectedShippingMethodId: fresh?.shippingMethod?.shippingMethodId
        ? String(fresh.shippingMethod.shippingMethodId)
        : null,
      pricingMinor: {
        subtotalMinor,
        discountTotalMinor: discountMinor,
        discountBreakdown: {
          couponMinor: ensureIntMinor(discountBreakdown.couponMinor ?? 0, "pricing.discountBreakdown.couponMinor"),
          promotionsMinor: ensureIntMinor(
            discountBreakdown.promotionsMinor ?? 0,
            "pricing.discountBreakdown.promotionsMinor",
          ),
        },
        shippingMinor: ensureIntMinor(fresh?.pricing?.shipping ?? 0, "pricing.shipping"),
        taxMinor: ensureIntMinor(fresh?.pricing?.taxMinor ?? fresh?.pricing?.tax ?? 0, "pricing.taxMinor"),
        grandTotalMinor: ensureIntMinor(fresh?.pricing?.grandTotal ?? 0, "pricing.grandTotal"),
        taxRateBps: Number.isInteger(fresh?.pricing?.taxRateBps) ? fresh.pricing.taxRateBps : 0,
        taxBasisMinor: ensureIntMinor(fresh?.pricing?.taxBasisMinor ?? 0, "pricing.taxBasisMinor"),
        taxCountrySnapshot: fresh?.pricing?.taxCountrySnapshot ?? null,
        taxCitySnapshot: fresh?.pricing?.taxCitySnapshot ?? null,
      },
      appliedPromotions: Array.isArray(fresh?.promotions) ? fresh.promotions : [],
      shipping: {
        city,
        payableSubtotalMinor,
        methods: shippingMethods,
      },
    };
  });
}
