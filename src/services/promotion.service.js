import { Promotion, PromotionRedemption, PromotionUserUsage } from "../models/index.js";
import { applyQueryBudget } from "../utils/queryBudget.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function normalizeCity(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStrList(values, { lower = true } = {}) {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((v) => String(v || "").trim())
    .map((v) => (lower ? v.toLowerCase() : v))
    .filter(Boolean);
}

function ensureMinorInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(500, "INVALID_MONEY_UNIT", `${field} must be int >= 0`);
  return n;
}

function isDuplicateKey(err) {
  const code = Number(err?.code || 0);
  if (code === 11000) return true;
  const msg = String(err?.message || "");
  return msg.includes("E11000 duplicate key error") || msg.includes("duplicate key error");
}

function isWithinWindow(promo, now) {
  if (promo?.startsAt && promo.startsAt > now) return false;
  if (promo?.endsAt && promo.endsAt <= now) return false;
  return true;
}

function cityEligible(promo, city) {
  const cities = normalizeStrList(promo?.eligibility?.cities || []);
  if (!cities.length) return true;
  const c = normalizeCity(city);
  if (!c) return false;
  return cities.includes(c);
}

function targetingEligible(promo, user) {
  const mode = String(promo?.targeting?.mode || "ALL");
  if (mode === "ALL") return { ok: true, reason: null };

  const userId = user?.userId ? String(user.userId) : null;
  const roles = normalizeStrList(user?.roles || []);
  const segments = normalizeStrList(user?.segments || []);

  if (mode === "WHITELIST") {
    const allowed = Array.isArray(promo?.targeting?.allowedUserIds)
      ? promo.targeting.allowedUserIds.map((id) => String(id))
      : [];
    if (!userId || !allowed.includes(userId)) return { ok: false, reason: "NOT_IN_WHITELIST" };
    return { ok: true, reason: null };
  }

  if (mode === "ROLES") {
    const allowed = normalizeStrList(promo?.targeting?.allowedRoles || []);
    const ok = roles.some((r) => allowed.includes(r));
    return ok ? { ok: true, reason: null } : { ok: false, reason: "ROLE_NOT_ELIGIBLE" };
  }

  if (mode === "SEGMENTS") {
    const allowed = normalizeStrList(promo?.targeting?.allowedSegments || []);
    const ok = segments.some((s) => allowed.includes(s));
    return ok ? { ok: true, reason: null } : { ok: false, reason: "SEGMENT_NOT_ELIGIBLE" };
  }

  return { ok: false, reason: "TARGETING_NOT_SUPPORTED" };
}

function computeEligibleSubtotalMinor(items, promo) {
  const list = Array.isArray(items) ? items : [];

  const includeProducts = new Set(
    (promo?.scope?.include?.products || []).map((id) => String(id)),
  );
  const includeCategories = new Set(
    (promo?.scope?.include?.categories || []).map((id) => String(id)),
  );
  const includeBrands = new Set(
    normalizeStrList(promo?.scope?.include?.brands || []),
  );

  const excludeProducts = new Set(
    (promo?.scope?.exclude?.products || []).map((id) => String(id)),
  );
  const excludeCategories = new Set(
    (promo?.scope?.exclude?.categories || []).map((id) => String(id)),
  );
  const excludeBrands = new Set(
    normalizeStrList(promo?.scope?.exclude?.brands || []),
  );

  const hasInclude =
    includeProducts.size || includeCategories.size || includeBrands.size;
  const storewide = promo?.scope?.storewide !== false;

  let eligibleSubtotal = 0;

  for (const it of list) {
    const productId = it?.productId ? String(it.productId) : "";
    const categoryIds = Array.isArray(it?.categoryIds)
      ? it.categoryIds.map((id) => String(id))
      : [];
    const brand = normalizeStrList([it?.brand || ""])[0] || "";
    const lineSubtotalMinor = ensureMinorInt(it?.lineSubtotalMinor ?? 0, "items[].lineSubtotalMinor");

    const isExcluded =
      (productId && excludeProducts.has(productId)) ||
      categoryIds.some((c) => excludeCategories.has(c)) ||
      (brand && excludeBrands.has(brand));
    if (isExcluded) continue;

    let included = false;
    if (storewide && !hasInclude) {
      included = true;
    } else {
      if (productId && includeProducts.has(productId)) included = true;
      if (!included && categoryIds.some((c) => includeCategories.has(c))) included = true;
      if (!included && brand && includeBrands.has(brand)) included = true;
    }

    if (included) eligibleSubtotal += lineSubtotalMinor;
  }

  return ensureMinorInt(eligibleSubtotal, "eligibleSubtotalMinor");
}

function computeDiscountMinor(promo, { eligibleSubtotalMinor, shippingMinor }) {
  const type = String(promo?.type || "");
  if (type === "PERCENT") {
    const pct = Number(promo?.value);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw httpError(400, "PROMO_INVALID", "Percent promotion value must be in (0..100]");
    }
    return Math.floor((eligibleSubtotalMinor * pct) / 100);
  }

  if (type === "FIXED") {
    const amount = ensureMinorInt(promo?.value ?? 0, "promotion.value");
    return Math.min(eligibleSubtotalMinor, amount);
  }

  if (type === "FREE_SHIPPING") {
    const shipping = Number.isInteger(shippingMinor) ? shippingMinor : 0;
    return Math.max(0, shipping);
  }

  return 0;
}

function applyMaxDiscount(discountMinor, promo) {
  const cap = promo?.eligibility?.maxDiscountMinor;
  if (cap === null || cap === undefined) return discountMinor;
  const max = ensureMinorInt(cap, "promotion.eligibility.maxDiscountMinor");
  return Math.min(discountMinor, max);
}

function promotionCodeMatches(promo, providedCode) {
  const promoCode = normalizeCode(promo?.code || "");
  if (!promoCode) return true;
  const input = normalizeCode(providedCode || "");
  return promoCode === input;
}

export function evaluatePromotions({ promotions, ctx, includeIneligible = false } = {}) {
  const list = Array.isArray(promotions) ? promotions : [];
  const now = ctx?.now instanceof Date ? ctx.now : new Date();
  const subtotalMinor = ensureMinorInt(ctx?.subtotalMinor ?? 0, "subtotalMinor");
  const shippingMinor = Number.isInteger(ctx?.shippingMinor) ? ctx.shippingMinor : null;
  const providedCode = normalizeCode(ctx?.code || "");

  const out = [];

  for (const promo of list) {
    const reasons = [];
    const isActive = promo?.isActive !== false;

    if (!isActive) reasons.push("INACTIVE");
    if (!isWithinWindow(promo, now)) reasons.push("OUTSIDE_WINDOW");

    if (promo?.code) {
      if (!providedCode) reasons.push("CODE_REQUIRED");
      else if (!promotionCodeMatches(promo, providedCode)) reasons.push("CODE_MISMATCH");
    }

    const targeting = targetingEligible(promo, ctx?.user);
    if (!targeting.ok) reasons.push(targeting.reason || "TARGETING_NOT_ELIGIBLE");

    if (!cityEligible(promo, ctx?.city)) reasons.push("CITY_NOT_ELIGIBLE");

    const minSubtotal = promo?.eligibility?.minSubtotalMinor ?? 0;
    if (Number.isFinite(minSubtotal) && subtotalMinor < Number(minSubtotal)) {
      reasons.push("SUBTOTAL_BELOW_MIN");
    }

    const eligibleSubtotalMinor = computeEligibleSubtotalMinor(ctx?.items, promo);
    if (eligibleSubtotalMinor <= 0 && promo?.type !== "FREE_SHIPPING") {
      reasons.push("SCOPE_NO_ITEMS");
    }

    let discountMinor = 0;
    if (reasons.length === 0) {
      discountMinor = computeDiscountMinor(promo, { eligibleSubtotalMinor, shippingMinor });
      discountMinor = applyMaxDiscount(discountMinor, promo);
      if (discountMinor <= 0 && promo?.type !== "FREE_SHIPPING") {
        reasons.push("DISCOUNT_ZERO");
      }
    }

    const eligible = reasons.length === 0;
    if (eligible || includeIneligible) {
      out.push({
        promotion: promo,
        eligible,
        discountMinor,
        eligibleSubtotalMinor,
        reasons,
      });
    }
  }

  return out;
}

export function selectPromotions(evaluated, { allowZero = false } = {}) {
  const list = Array.isArray(evaluated) ? evaluated : [];
  const eligible = list.filter((x) => x?.eligible && (allowZero || x.discountMinor > 0));

  eligible.sort((a, b) => {
    const pa = Number(a?.promotion?.priority || 0);
    const pb = Number(b?.promotion?.priority || 0);
    if (pb !== pa) return pb - pa;
    const da = Number(a?.discountMinor || 0);
    const db = Number(b?.discountMinor || 0);
    if (db !== da) return db - da;
    return String(a?.promotion?._id || "").localeCompare(String(b?.promotion?._id || ""));
  });

  if (!eligible.length) return [];

  const selected = [eligible[0]];
  const top = eligible[0];
  const topPolicy = String(top?.promotion?.stackingPolicy || "EXCLUSIVE");
  if (topPolicy === "EXCLUSIVE") return selected;

  const hasFreeShipping = (list) =>
    list.some((x) => String(x?.promotion?.type || "") === "FREE_SHIPPING");

  for (let i = 1; i < eligible.length; i += 1) {
    const candidate = eligible[i];
    const cPolicy = String(candidate?.promotion?.stackingPolicy || "EXCLUSIVE");
    const cPriority = Number(candidate?.promotion?.priority || 0);

    if (cPolicy === "EXCLUSIVE") continue;
    if (hasFreeShipping(selected) && String(candidate?.promotion?.type || "") === "FREE_SHIPPING") {
      continue;
    }

    if (topPolicy === "STACKABLE_SAME_PRIORITY_ONLY" && cPriority !== Number(top?.promotion?.priority || 0)) {
      continue;
    }

    if (cPolicy === "STACKABLE_SAME_PRIORITY_ONLY" && cPriority !== Number(top?.promotion?.priority || 0)) {
      continue;
    }

    selected.push(candidate);
  }

  return selected;
}

export async function fetchPromotionsForPricing({ code, now = new Date(), session } = {}) {
  const normalized = normalizeCode(code || "");
  const filter = {
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ],
  };

  const or = [];
  or.push({ autoApply: true });
  if (normalized) or.push({ code: normalized });
  if (or.length) filter.$or = or;

  return await applyQueryBudget(
    Promotion.find(filter).session(session).lean(),
  );
}

async function reserveUserUsage({ promotionId, userId, maxUsesPerUser, session }) {
  if (maxUsesPerUser == null) return { incremented: false };
  const limit = Number(maxUsesPerUser);
  if (!Number.isFinite(limit) || limit < 0) {
    throw httpError(400, "PROMO_INVALID", "Promotion per-user limit is invalid");
  }
  if (limit === 0) return { incremented: false, maxReached: true };

  const updated = await applyQueryBudget(
    PromotionUserUsage.findOneAndUpdate(
      { promotionId, userId, usesTotal: { $lt: limit } },
      { $inc: { usesTotal: 1 } },
      { new: true, session },
    ),
  );
  if (updated) return { incremented: true };

  try {
    await PromotionUserUsage.create(
      [{ promotionId, userId, usesTotal: 1 }],
      { session },
    );
    return { incremented: true, inserted: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }

  const retry = await applyQueryBudget(
    PromotionUserUsage.findOneAndUpdate(
      { promotionId, userId, usesTotal: { $lt: limit } },
      { $inc: { usesTotal: 1 } },
      { new: true, session },
    ),
  );

  if (retry) return { incremented: true };
  return { incremented: false, maxReached: true };
}

async function releaseUserUsage({ promotionId, userId, session }) {
  if (!promotionId || !userId) return;
  await applyQueryBudget(
    PromotionUserUsage.updateOne(
      { promotionId, userId, usesTotal: { $gt: 0 } },
      { $inc: { usesTotal: -1 } },
      { session },
    ),
  );
}

export async function reservePromotionsForOrder({ orderId, userId, promotionsApplied, session }) {
  const list = Array.isArray(promotionsApplied) ? promotionsApplied : [];
  const applied = [];

  for (const entry of list) {
    const promo = entry?.promotion || entry;
    if (!promo?._id) continue;

    const promotionId = promo._id;
    const promoUserId = userId || null;

    const rawRes = await PromotionRedemption.findOneAndUpdate(
      { promotionId, orderId },
      {
        $setOnInsert: {
          promotionId,
          orderId,
          userId: promoUserId,
          status: "reserved",
        },
        $set: {
          status: "reserved",
          userId: promoUserId,
        },
      },
      { upsert: true, new: false, rawResult: true, session },
    );

    const prev = rawRes?.value || null;
    const wasInserted = rawRes?.lastErrorObject?.updatedExisting === false;
    const shouldCount = wasInserted || prev?.status === "released";

    const rollbackRedemption = async () => {
      if (wasInserted) {
        await PromotionRedemption.deleteOne({ promotionId, orderId }, { session });
        return;
      }
      if (!prev?._id) return;
      await PromotionRedemption.updateOne(
        { _id: prev._id },
        { $set: { status: prev.status || "released", userId: prev.userId || null } },
        { session },
      );
    };

    if (shouldCount && promo?.limits?.maxUsesPerUser != null) {
      if (!promoUserId) {
        await rollbackRedemption();
        throw httpError(403, "PROMO_USER_REQUIRED", "Promotion requires a user account");
      }
      const usage = await reserveUserUsage({
        promotionId,
        userId: promoUserId,
        maxUsesPerUser: promo.limits.maxUsesPerUser,
        session,
      });
      if (!usage.incremented) {
        await rollbackRedemption();
        throw httpError(409, "PROMO_MAX_USES_PER_USER_REACHED", "Promotion maximum uses per user reached");
      }
    }

    if (shouldCount) {
      const updated = await Promotion.findOneAndUpdate(
        {
          _id: promotionId,
          $expr: {
            $lt: ["$limits.usesTotal", { $ifNull: ["$limits.maxUsesTotal", 9007199254740991] }],
          },
        },
        { $inc: { "limits.usesTotal": 1 } },
        { new: true, session },
      ).lean();

      if (!updated) {
        if (promo?.limits?.maxUsesPerUser != null && promoUserId) {
          await releaseUserUsage({ promotionId, userId: promoUserId, session });
        }
        await rollbackRedemption();
        throw httpError(409, "PROMO_MAX_USES_REACHED", "Promotion maximum uses reached");
      }
    }

    applied.push(promo);
  }

  return applied;
}

export async function releasePromotionsForOrder({ orderId, promotionIds, session }) {
  const filter = { orderId, status: "reserved" };
  if (Array.isArray(promotionIds) && promotionIds.length) {
    filter.promotionId = { $in: promotionIds };
  }

  const redemptions = await applyQueryBudget(
    PromotionRedemption.find(filter).session(session).lean(),
  );
  if (!redemptions.length) return { released: 0 };

  const ids = redemptions.map((r) => r._id);
  await PromotionRedemption.updateMany(
    { _id: { $in: ids } },
    { $set: { status: "released" } },
    { session },
  );

  for (const red of redemptions) {
    await Promotion.updateOne(
      { _id: red.promotionId, "limits.usesTotal": { $gt: 0 } },
      { $inc: { "limits.usesTotal": -1 } },
      { session },
    );
    if (red.userId) {
      await releaseUserUsage({ promotionId: red.promotionId, userId: red.userId, session });
    }
  }

  return { released: redemptions.length };
}

export async function confirmPromotionsForOrder(orderId) {
  await PromotionRedemption.updateMany(
    { orderId, status: "reserved" },
    { $set: { status: "confirmed" } },
  );
}

export function buildPromotionSnapshot(entry) {
  const promo = entry?.promotion || entry;
  return {
    promotionId: promo?._id,
    nameSnapshot: promo?.name || "",
    codeSnapshot: promo?.code || null,
    type: promo?.type || null,
    discountMinor: ensureMinorInt(entry?.discountMinor ?? 0, "promotion.discountMinor"),
    prioritySnapshot: Number(promo?.priority || 0),
    stackingPolicySnapshot: promo?.stackingPolicy || null,
  };
}
