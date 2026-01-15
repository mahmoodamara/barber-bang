// src/services/coupons/coupon.service.js
// Phase 8/9+ Hardened: apply/remove/confirm + read-only evaluate (for totals preview)
//
// Key improvements vs your version:
// - Removed unused mongoose import
// - Stronger auth parsing (supports req.auth shapes)
// - Safer currency handling (optional, soft by default)
// - Stronger max-uses atomic enforcement + rollback
// - Defensive pricing defaults + strict minor-unit validation
// - Added evaluateCoupon (fixes your money.js import issue)
// - Ensures redemption code stays consistent + idempotent operations
// - Uses lean() where it’s safe for performance

import { Coupon, CouponRedemption, CouponUserUsage, Order, User } from "../models/index.js";
import { normalizeCurrency } from "../utils/stripe.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { withRequiredTransaction } from "../utils/mongoTx.js";
import { repriceOrder } from "./reprice.service.js";

// --------------------
// Errors / helpers
// --------------------
function httpError(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function withSessionOpts(opts, session) {
  return session ? { ...(opts || {}), session } : opts || {};
}

function withSessionQuery(query, session) {
  return session ? query.session(session) : query;
}

function ensureIntMinor(v, field) {
  if (!Number.isInteger(v) || v < 0) {
    throw httpError(400, "INVALID_MONEY_UNIT", `${field} must be integer (minor units) >= 0`);
  }
}

function isDuplicateKey(err) {
  const code = Number(err?.code || 0);
  if (code === 11000) return true;
  const msg = String(err?.message || "");
  return msg.includes("E11000 duplicate key error") || msg.includes("duplicate key error");
}

function normalizeRoleList(roles) {
  return Array.isArray(roles)
    ? roles.map((r) => String(r || "").trim()).filter(Boolean)
    : [];
}

async function reserveUserUsage({ couponId, userId, maxUsesPerUser, session }) {
  if (maxUsesPerUser == null) return { incremented: false };

  const limit = Number(maxUsesPerUser);
  if (!Number.isFinite(limit) || limit < 0) {
    throw httpError(400, "COUPON_INVALID", "Coupon per-user limit is invalid");
  }
  if (limit === 0) return { incremented: false, maxReached: true };

  const updated = await applyQueryBudget(
    CouponUserUsage.findOneAndUpdate(
      { couponId, userId, usesTotal: { $lt: limit } },
      { $inc: { usesTotal: 1 } },
      withSessionOpts({ new: true }, session),
    ),
  );

  if (updated) return { incremented: true };

  try {
    await CouponUserUsage.create(
      [{ couponId, userId, usesTotal: 1 }],
      withSessionOpts({}, session),
    );
    return { incremented: true, inserted: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const retry = await applyQueryBudget(
    CouponUserUsage.findOneAndUpdate(
      { couponId, userId, usesTotal: { $lt: limit } },
      { $inc: { usesTotal: 1 } },
      withSessionOpts({ new: true }, session),
    ),
  );

  if (retry) return { incremented: true };

  return { incremented: false, maxReached: true };
}

async function releaseUserUsage({ couponId, userId, session }) {
  if (!couponId || !userId) return;
  await applyQueryBudget(
    CouponUserUsage.updateOne(
      { couponId, userId, usesTotal: { $gt: 0 } },
      { $inc: { usesTotal: -1 } },
      withSessionOpts({}, session),
    ),
  );
}

function isEditableOrderStatus(status) {
  return status === "draft" || status === "pending_payment";
}

function pickAuth(auth) {
  // supports: { role, userId }, { user: { role, _id } }, { roles:[] }, etc.
  const role =
    auth?.role ||
    auth?.user?.role ||
    (Array.isArray(auth?.roles) && auth.roles.includes("admin") ? "admin" : null) ||
    "user";

  const userId =
    auth?.userId ||
    auth?._id ||
    auth?.id ||
    auth?.user?._id ||
    auth?.user?.id ||
    null;

  const roles =
    Array.isArray(auth?.roles) ? auth.roles :
    Array.isArray(auth?.user?.roles) ? auth.user.roles :
    role ? [role] : [];

  return { role, userId, roles };
}

function ensureOrderAuthz(order, auth) {
  const { role, userId } = pickAuth(auth);

  if (role === "admin" || role === "staff") return;

  const isOwner = order?.userId && userId && String(order.userId) === String(userId);
  if (!isOwner) throw httpError(403, "FORBIDDEN", "Not allowed to modify this order");
}

function ensureCouponWindow(coupon, now) {
  if (!coupon?.isActive) throw httpError(409, "COUPON_NOT_ACTIVE", "Coupon is not active");
  if (coupon.startsAt && coupon.startsAt > now) {
    throw httpError(409, "COUPON_NOT_STARTED", "Coupon not started yet");
  }
  if (coupon.endsAt && coupon.endsAt <= now) {
    throw httpError(409, "COUPON_EXPIRED", "Coupon expired");
  }
}

function computeDiscountMinor({ coupon, subtotal }) {
  ensureIntMinor(subtotal, "pricing.subtotal");

  if (coupon.type === "percent") {
    const pct = coupon.value;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw httpError(400, "COUPON_INVALID", "Percent coupon value must be in (0..100]");
    }
    return Math.floor((subtotal * pct) / 100);
  }

  // fixed (minor units integer)
  const fixed = coupon.value;
  if (!Number.isInteger(fixed) || fixed <= 0) {
    throw httpError(400, "COUPON_INVALID", "Fixed coupon value must be integer minor units > 0");
  }

  return Math.min(subtotal, fixed);
}

async function releaseReservedRedemption({ couponId, orderId, session }) {
  // release only if reserved (idempotent)
  const red = await CouponRedemption.findOneAndUpdate(
    { couponId, orderId, status: "reserved" },
    { $set: { status: "released", releasedAt: new Date() } },
    withSessionOpts({ new: true }, session),
  );

  // decrement only if we actually released an active reservation
  if (red) {
    await Coupon.findOneAndUpdate(
      { _id: couponId, usesTotal: { $gt: 0 } },
      { $inc: { usesTotal: -1 } },
      withSessionOpts({ new: true }, session),
    ).lean();
    if (red.userId) {
      await releaseUserUsage({ couponId, userId: red.userId, session });
    }
  }
}

// --------------------
// Read-only evaluation (fix for money.js)
// --------------------
export async function evaluateCoupon({ code, subtotal, currency = null, now = new Date() }) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "COUPON_REQUIRED" };

  ensureIntMinor(subtotal ?? 0, "subtotal");

  const coupon = await applyQueryBudget(
    Coupon.findOne({ code: normalized })
      .select("code type value currency minOrderTotal maxUsesTotal usesTotal startsAt endsAt isActive")
      .lean(),
  );

  if (!coupon) return { ok: false, reason: "COUPON_NOT_FOUND" };

  try {
    ensureCouponWindow(coupon, now);
  } catch (e) {
    return { ok: false, reason: e.code || "COUPON_NOT_VALID" };
  }

  const inputCurrency = normalizeCurrency(currency);
  const couponCurrency = normalizeCurrency(coupon.currency);
  if (inputCurrency && couponCurrency && inputCurrency !== couponCurrency) {
    return { ok: false, reason: "COUPON_CURRENCY_MISMATCH" };
  }

  if (coupon.minOrderTotal && subtotal < coupon.minOrderTotal) {
    return {
      ok: false,
      reason: "COUPON_MIN_ORDER_NOT_MET",
      minOrderTotal: coupon.minOrderTotal,
    };
  }

  if (coupon.maxUsesTotal != null && Number(coupon.usesTotal || 0) >= Number(coupon.maxUsesTotal)) {
    return { ok: false, reason: "COUPON_MAX_USES_REACHED" };
  }

  const discountTotal = computeDiscountMinor({ coupon, subtotal });
  return {
    ok: true,
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    currency: couponCurrency || "ILS",
    discountTotal,
  };
}

// --------------------
// Apply coupon (reserve redemption + increment usesTotal)
// --------------------
export async function applyCouponToOrder({ orderId, auth, code, options = {} }) {
  const session = options.session;
  const normalized = normalizeCode(code);
  if (!normalized) throw httpError(400, "COUPON_REQUIRED", "Coupon code is required");

  const work = async (s) => {
    const order = await applyQueryBudget(withSessionQuery(Order.findById(orderId), s));
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    ensureOrderAuthz(order, auth);

    if (!isEditableOrderStatus(order.status)) {
      throw httpError(409, "ORDER_NOT_EDITABLE", "Order cannot be modified in its current status");
    }

    // If same code already applied => idempotent (still enforce repricing)
    if (order.coupon?.code && normalizeCode(order.coupon.code) === normalized) {
      await repriceOrder(order._id, { session: s });
      return await applyQueryBudget(withSessionQuery(Order.findById(order._id), s));
    }

    const now = new Date();
    const { userId: authUserId, roles: authRoles } = pickAuth(auth);

    // lean not used here because we need doc later for compute
    const coupon = await applyQueryBudget(
      withSessionQuery(Coupon.findOne({ code: normalized }), s),
    );
    if (!coupon) throw httpError(404, "COUPON_NOT_FOUND", "Coupon not found");

    ensureCouponWindow(coupon, now);

    // currency check (soft): only enforce if order has currency explicitly
    const orderCurrency = normalizeCurrency(order.pricing?.currency);
    const couponCurrencyApply = normalizeCurrency(coupon.currency);
    if (orderCurrency && couponCurrencyApply && orderCurrency !== couponCurrencyApply) {
      throw httpError(409, "COUPON_CURRENCY_MISMATCH", "Coupon currency does not match order currency");
    }

    const subtotal = order.pricing?.subtotal ?? 0;
    ensureIntMinor(subtotal, "pricing.subtotal");

    if (coupon.minOrderTotal && subtotal < coupon.minOrderTotal) {
      throw httpError(409, "COUPON_MIN_ORDER_NOT_MET", "Order subtotal does not meet coupon minimum");
    }

    const allowedUserIds = Array.isArray(coupon.allowedUserIds)
      ? coupon.allowedUserIds.map((id) => String(id))
      : [];
    const allowedRoles = normalizeRoleList(coupon.allowedRoles);
    const redemptionUserId = order.userId || authUserId || null;

    if (allowedUserIds.length) {
      if (!redemptionUserId || !allowedUserIds.includes(String(redemptionUserId))) {
        throw httpError(403, "COUPON_NOT_ELIGIBLE_FOR_USER", "Coupon is not available for this user");
      }
    }

    if (allowedRoles.length) {
      let targetRoles = [];
      if (order.userId) {
        const userDoc = await applyQueryBudget(
          withSessionQuery(User.findById(order.userId).select("roles").lean(), s),
        );
        targetRoles = normalizeRoleList(userDoc?.roles);
      } else {
        targetRoles = normalizeRoleList(authRoles);
      }

      const hasRole = targetRoles.some((r) => allowedRoles.includes(r));
      if (!hasRole) {
        throw httpError(403, "COUPON_NOT_ELIGIBLE_FOR_USER", "Coupon is not available for this user");
      }
    }

    if (!redemptionUserId) {
      throw httpError(409, "COUPON_USER_REQUIRED", "Coupon requires a user account");
    }

    // If order already has another coupon => remove it first (release)
    if (order.coupon?.code) {
      await removeCouponFromOrder({ orderId: order._id, auth, _internal: true, options: { session: s } });
      const reloaded = await applyQueryBudget(withSessionQuery(Order.findById(order._id), s));
      if (!reloaded) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");
      order.set(reloaded.toObject());
    }

    const discountMinor = computeDiscountMinor({ coupon, subtotal });
    const currencySnapshot = orderCurrency || couponCurrencyApply || "ILS";

    // 1) Reserve redemption (upsert). Unique (couponId, orderId) makes this idempotent.
    const rawRes = await CouponRedemption.findOneAndUpdate(
      { couponId: coupon._id, orderId: order._id },
      {
        $setOnInsert: {
          couponId: coupon._id,
          orderId: order._id,
          userId: redemptionUserId,
          code: normalized,
          status: "reserved",
          reservedAt: now,
          discountTotalMinor: discountMinor,
          currencySnapshot,
        },
        $set: {
          status: "reserved",
          reservedAt: now,
          confirmedAt: null,
          releasedAt: null,
          userId: redemptionUserId,
          code: normalized,
          discountTotalMinor: discountMinor,
          currencySnapshot,
        },
      },
      withSessionOpts({ upsert: true, new: false, rawResult: true }, s),
    );

    const prevRedemption = rawRes.value || null;
    const wasInserted = rawRes?.lastErrorObject?.updatedExisting === false;
    const shouldCount = wasInserted || prevRedemption?.status === "released";

    const rollbackRedemption = async () => {
      if (wasInserted) {
        await CouponRedemption.deleteOne(
          { couponId: coupon._id, orderId: order._id },
          withSessionOpts({}, s),
        );
        return;
      }

      if (!prevRedemption?._id) return;
      await CouponRedemption.updateOne(
        { _id: prevRedemption._id },
        {
          $set: {
            status: prevRedemption.status ?? "released",
            reservedAt: prevRedemption.reservedAt ?? null,
            confirmedAt: prevRedemption.confirmedAt ?? null,
            releasedAt: prevRedemption.releasedAt ?? null,
            userId: prevRedemption.userId ?? null,
            code: prevRedemption.code ?? normalized,
            discountTotalMinor: prevRedemption.discountTotalMinor ?? null,
            currencySnapshot: prevRedemption.currencySnapshot ?? null,
          },
        },
        withSessionOpts({}, s),
      );
    };

    let redemption = prevRedemption;
    if (!redemption) {
      redemption = await applyQueryBudget(
        withSessionQuery(
          CouponRedemption.findOne({ couponId: coupon._id, orderId: order._id }),
          s,
        ),
      );
    }
    if (!redemption) {
      await rollbackRedemption();
      throw httpError(500, "COUPON_REDEMPTION_CREATE_FAILED", "Failed to reserve coupon redemption");
    }

    let userUsageIncremented = false;
    if (shouldCount && coupon.maxUsesPerUser != null) {
      const usageRes = await reserveUserUsage({
        couponId: coupon._id,
        userId: redemptionUserId,
        maxUsesPerUser: coupon.maxUsesPerUser,
        session: s,
      });

      if (!usageRes.incremented) {
        await rollbackRedemption();
        throw httpError(
          409,
          "COUPON_MAX_USES_PER_USER_REACHED",
          "Coupon maximum uses per user reached",
        );
      }
      userUsageIncremented = true;
    }

    // 2) If newly inserted or re-reserved => increment usesTotal with maxUsesTotal constraint (atomic)
    if (shouldCount) {
      const updated = await Coupon.findOneAndUpdate(
        {
          _id: coupon._id,
          $expr: {
            $lt: ["$usesTotal", { $ifNull: ["$maxUsesTotal", 9007199254740991] }],
          },
        },
        { $inc: { usesTotal: 1 } },
        withSessionOpts({ new: true }, s),
      ).lean();

      if (!updated) {
        if (userUsageIncremented) {
          await releaseUserUsage({ couponId: coupon._id, userId: redemptionUserId, session: s });
        }
        await rollbackRedemption();
        throw httpError(409, "COUPON_MAX_USES_REACHED", "Coupon maximum uses reached");
      }
    }

    // 3) Apply coupon snapshot, then compute totals via repriceOrder (single source of truth)

    order.coupon = {
      code: normalized,
      discountTotal: discountMinor,
      meta: {
        couponId: String(coupon._id),
        redemptionId: String(redemption._id),
        type: coupon.type,
        value: coupon.value,
      },
    };

    await order.save(withSessionOpts({}, s));
    await repriceOrder(order._id, { session: s });
    return await applyQueryBudget(withSessionQuery(Order.findById(order._id), s));
  };

  if (session) return await work(session);
  return await withRequiredTransaction(work);
}

// --------------------
// Remove coupon (release redemption + decrement usesTotal)
// --------------------
export async function removeCouponFromOrder({ orderId, auth, _internal = false, options = {} }) {
  const session = options.session;
  const work = async (s) => {
    const order = await applyQueryBudget(withSessionQuery(Order.findById(orderId), s));
    if (!order) throw httpError(404, "ORDER_NOT_FOUND", "Order not found");

    if (!_internal) {
      ensureOrderAuthz(order, auth);

      if (!isEditableOrderStatus(order.status)) {
        throw httpError(409, "ORDER_NOT_EDITABLE", "Order cannot be modified in its current status");
      }
    }

    const currentCode = order.coupon?.code ? normalizeCode(order.coupon.code) : "";
    if (!currentCode) return order; // idempotent

    const coupon = await applyQueryBudget(
      withSessionQuery(
        Coupon.findOne({ code: currentCode }).select("_id code").lean(),
        s,
      ),
    );

    if (coupon) {
      await releaseReservedRedemption({ couponId: coupon._id, orderId: order._id, session: s });
    }

    order.coupon = { code: null, discountTotal: 0, meta: {} };

    await order.save(withSessionOpts({}, s));
    await repriceOrder(order._id, { session: s });
    return await applyQueryBudget(withSessionQuery(Order.findById(order._id), s));
  };

  if (session) return await work(session);
  return await withRequiredTransaction(work);
}

// --------------------
// Confirm coupon on paid order (webhook hook)
// --------------------
export async function confirmCouponForPaidOrder(orderId) {
  const order = await applyQueryBudget(
    Order.findById(orderId).select("coupon.code").lean(),
  );
  if (!order?.coupon?.code) return;

  const code = normalizeCode(order.coupon.code);
  const coupon = await applyQueryBudget(
    Coupon.findOne({ code }).select("_id").lean(),
  );
  if (!coupon) return;

  await CouponRedemption.findOneAndUpdate(
    { couponId: coupon._id, orderId, status: "reserved" },
    { $set: { status: "confirmed", confirmedAt: new Date() } },
    { new: true },
  ).lean();
}
