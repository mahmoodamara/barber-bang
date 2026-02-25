// src/utils/returns.policy.js

/* ============================
   Returns Policy (Israel-friendly MVP)
============================ */

/**
 * Defaults:
 * - 14-day return window
 * - refund excludes shipping by default
 *
 * You can change behavior via env:
 * - RETURN_WINDOW_DAYS=14
 * - RETURN_ALLOW_STATUS=delivered   (or: confirmed,shipped,delivered)
 * - RETURN_INCLUDE_SHIPPING=false
 */

function getReturnWindowDays() {
  const v = Number(process.env.RETURN_WINDOW_DAYS || 14);
  if (!Number.isFinite(v) || v <= 0) return 14;
  return Math.min(60, Math.max(1, Math.floor(v)));
}

function getAllowedStatusesSet() {
  const raw = String(process.env.RETURN_ALLOW_STATUS || "delivered")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowed = new Set(raw.length ? raw : ["delivered"]);
  return allowed;
}

function shouldIncludeShippingByDefault() {
  const v = String(
    process.env.RETURN_INCLUDE_SHIPPING || "false",
  ).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function clampMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function daysBetween(a, b) {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/* ============================
   Public: Eligibility
============================ */

/**
 * Evaluate return eligibility based on order.
 * Uses createdAt as base timestamp for MVP.
 * (If you later add deliveredAt, switch to that)
 */
export function evaluateReturnEligibility(order) {
  const windowDays = getReturnWindowDays();
  const allowedStatuses = getAllowedStatusesSet();

  if (!order) {
    return { eligible: false, code: "INVALID_ORDER", message: "Order missing" };
  }

  const status = String(order.status || "");
  if (!allowedStatuses.has(status)) {
    return {
      eligible: false,
      code: "STATUS_NOT_ALLOWED",
      message: `Return not allowed for status: ${status}`,
    };
  }

  // If already refunded fully, no return
  const refundStatus = String(order?.refund?.status || "none");
  if (refundStatus === "succeeded" && status === "refunded") {
    return {
      eligible: false,
      code: "ALREADY_REFUNDED",
      message: "Order already refunded",
    };
  }

  // If a return is already in progress / completed
  const retStatus = String(order?.return?.status || "none");
  if (retStatus && retStatus !== "none" && retStatus !== "requested") {
    return {
      eligible: false,
      code: "RETURN_ALREADY_PROCESSED",
      message: `Return already processed: ${retStatus}`,
    };
  }

  const baseDate =
    (order.deliveredAt && new Date(order.deliveredAt)) ||
    (order.shippedAt && new Date(order.shippedAt)) ||
    (order.createdAt && new Date(order.createdAt)) ||
    null;
  if (!baseDate) {
    return {
      eligible: false,
      code: "MISSING_DATE",
      message: "Order has no base date",
    };
  }

  const now = new Date();
  const ageDays = daysBetween(now, baseDate);

  if (ageDays > windowDays) {
    return {
      eligible: false,
      code: "RETURN_WINDOW_EXPIRED",
      message: `Return window expired (${ageDays} days > ${windowDays} days)`,
      meta: { ageDays, windowDays },
    };
  }

  return {
    eligible: true,
    code: "OK",
    message: "Return is allowed",
    meta: { ageDays, windowDays, allowedStatuses: [...allowedStatuses] },
  };
}

/* ============================
   Public: Amount calculation
============================ */

/**
 * Compute the gross subtotal of all order items (before discounts).
 */
function computeItemsSubtotal(orderItems) {
  return orderItems.reduce((sum, it) => {
    const unit = clampMoney(it?.unitPrice ?? 0);
    const qty = Math.max(1, Math.min(999, Number(it?.qty || 1)));
    return sum + unit * qty;
  }, 0);
}

/**
 * Compute the proportional discount ratio for the order.
 * ratio = totalDiscount / itemsSubtotal  (clamped 0..1)
 */
function computeDiscountRatio(order, itemsSubtotal) {
  const discounts = order?.pricing?.discounts ?? {};
  const discountTotal = clampMoney(
    Number(order?.pricing?.discountTotal ?? 0) ||
      Number(discounts?.coupon?.amount ?? 0) +
        Number(discounts?.campaign?.amount ?? 0) +
        Number(discounts?.offer?.amount ?? 0),
  );
  if (discountTotal <= 0 || itemsSubtotal <= 0) return 0;
  return Math.min(1, discountTotal / itemsSubtotal);
}

/**
 * Compute refund amount for returned items (discount-aware).
 *
 * If returnItems is null/empty -> full refund (items subtotal minus proportional discount, optionally shipping)
 * If returnItems provided -> partial refund with proportional discount allocated per-item
 *
 * Discount allocation: each item's effective refund price = unitPrice * (1 - discountRatio)
 * This prevents over-refunding on discounted orders when only some items are returned.
 */
export function computeReturnRefundAmountMajor({
  order,
  returnItems,
  includeShipping,
}) {
  if (!order) return 0;

  const orderItems = Array.isArray(order.items) ? order.items : [];
  const totalMajor = clampMoney(order?.pricing?.total ?? 0);
  const shippingMajor = clampMoney(order?.pricing?.shippingFee ?? 0);

  const includeShip =
    typeof includeShipping === "boolean"
      ? includeShipping
      : shouldIncludeShippingByDefault();

  const itemsSubtotal = computeItemsSubtotal(orderItems);
  const discountRatio = computeDiscountRatio(order, itemsSubtotal);

  // Full refund if returnItems not specified
  if (!Array.isArray(returnItems) || returnItems.length === 0) {
    const discountedSubtotal = clampMoney(itemsSubtotal * (1 - discountRatio));
    const wanted = clampMoney(
      discountedSubtotal + (includeShip ? shippingMajor : 0),
    );
    return Math.min(wanted, totalMajor);
  }

  // Partial based on supplied items, with proportional discount
  const byId = new Map(orderItems.map((it) => [String(it.productId), it]));

  let amount = 0;

  for (const r of returnItems) {
    const pid = String(r?.productId || "");
    const qty = Math.max(1, Math.min(999, Number(r?.qty || 1)));
    const it = byId.get(pid);
    if (!it) continue;

    const boughtQty = Math.max(1, Math.min(999, Number(it.qty || 1)));
    const refundableQty = Math.min(qty, boughtQty);

    const unit = clampMoney(it.unitPrice || 0);
    const effectiveUnit = clampMoney(unit * (1 - discountRatio));
    amount += effectiveUnit * refundableQty;
  }

  amount = clampMoney(amount);

  if (includeShip) amount = clampMoney(amount + shippingMajor);
  return Math.min(amount, totalMajor);
}

/* ============================
   Public: Cancellation fee
============================ */

function getCancellationFeePercent() {
  const v = Number(process.env.CANCEL_FEE_PERCENT || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(100, Math.max(0, v));
}

function getCancellationFeeFixedMinor() {
  const v = Number(process.env.CANCEL_FEE_FIXED || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round((v + Number.EPSILON) * 100);
}

export function calcCancellationFee(totalMinor) {
  const total = Math.max(0, Math.round(Number(totalMinor || 0)));
  if (total <= 0) return 0;

  const pct = getCancellationFeePercent();
  const fixedMinor = getCancellationFeeFixedMinor();
  const percentMinor = Math.round(total * (pct / 100));

  const fee = Math.max(0, percentMinor + fixedMinor);
  return Math.min(total, fee);
}
