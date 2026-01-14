import { Promotion, Product, User, Variant } from "../models/index.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";
import { evaluatePromotions, selectPromotions } from "../services/promotion.service.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function parseDateOrNull(v) {
  if (v === null) return null;
  if (typeof v === "string") return new Date(v);
  return undefined;
}

function normalizeCodeOrNull(code) {
  if (code === null) return null;
  const v = String(code || "").trim().toUpperCase();
  return v.length ? v : null;
}

function normalizeStringList(list, { lower = true, max = 200 } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    const n = lower ? v.toLowerCase() : v;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeIdList(list, max = 200) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeScope(scope, existing) {
  if (!scope && !existing) return { storewide: true, include: {}, exclude: {} };

  const ex = existing || {};
  const inc = scope || {};

  return {
    storewide: inc.storewide !== undefined ? !!inc.storewide : ex.storewide ?? true,
    include: {
      products: inc.include?.products !== undefined
        ? normalizeIdList(inc.include.products)
        : normalizeIdList(ex.include?.products || []),
      categories: inc.include?.categories !== undefined
        ? normalizeIdList(inc.include.categories)
        : normalizeIdList(ex.include?.categories || []),
      brands: inc.include?.brands !== undefined
        ? normalizeStringList(inc.include.brands)
        : normalizeStringList(ex.include?.brands || []),
    },
    exclude: {
      products: inc.exclude?.products !== undefined
        ? normalizeIdList(inc.exclude.products)
        : normalizeIdList(ex.exclude?.products || []),
      categories: inc.exclude?.categories !== undefined
        ? normalizeIdList(inc.exclude.categories)
        : normalizeIdList(ex.exclude?.categories || []),
      brands: inc.exclude?.brands !== undefined
        ? normalizeStringList(inc.exclude.brands)
        : normalizeStringList(ex.exclude?.brands || []),
    },
  };
}

function normalizeTargeting(targeting, existing) {
  const ex = existing || {};
  const inc = targeting || {};
  return {
    mode: inc.mode ?? ex.mode ?? "ALL",
    allowedUserIds: inc.allowedUserIds !== undefined
      ? normalizeIdList(inc.allowedUserIds)
      : normalizeIdList(ex.allowedUserIds || []),
    allowedSegments: inc.allowedSegments !== undefined
      ? normalizeStringList(inc.allowedSegments)
      : normalizeStringList(ex.allowedSegments || []),
    allowedRoles: inc.allowedRoles !== undefined
      ? normalizeStringList(inc.allowedRoles)
      : normalizeStringList(ex.allowedRoles || []),
  };
}

function normalizeEligibility(eligibility, existing) {
  const ex = existing || {};
  const inc = eligibility || {};
  return {
    minSubtotalMinor: inc.minSubtotalMinor ?? ex.minSubtotalMinor ?? 0,
    maxDiscountMinor: inc.maxDiscountMinor !== undefined ? inc.maxDiscountMinor : ex.maxDiscountMinor ?? null,
    cities: inc.cities !== undefined ? normalizeStringList(inc.cities) : normalizeStringList(ex.cities || []),
  };
}

function normalizeLimits(limits, existing) {
  const ex = existing || {};
  const inc = limits || {};
  return {
    maxUsesTotal: inc.maxUsesTotal !== undefined ? inc.maxUsesTotal : ex.maxUsesTotal ?? null,
    maxUsesPerUser: inc.maxUsesPerUser !== undefined ? inc.maxUsesPerUser : ex.maxUsesPerUser ?? null,
    usesTotal: ex.usesTotal ?? 0,
  };
}

function normalizePromotionForOutput(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  if (Array.isArray(out?.targeting?.allowedUserIds)) {
    out.targeting.allowedUserIds = out.targeting.allowedUserIds.map((id) => String(id));
  }
  return out;
}

export async function listPromotions(req, res) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
  const q = String(req.query.q || "").trim();
  const isActive = String(req.query.isActive || "").trim();
  const autoApply = String(req.query.autoApply || "").trim();
  const hasCode = String(req.query.hasCode || "").trim();
  const activeAt = String(req.query.activeAt || "").trim();

  const filter = {};
  if (q) {
    filter.$or = [
      { name: new RegExp(q, "i") },
      { code: new RegExp(q, "i") },
    ];
  }
  if (isActive === "true") filter.isActive = true;
  if (isActive === "false") filter.isActive = false;
  if (autoApply === "true") filter.autoApply = true;
  if (autoApply === "false") filter.autoApply = false;
  if (hasCode === "true") filter.code = { $ne: null };
  if (hasCode === "false") filter.code = null;

  if (activeAt) {
    const when = new Date(activeAt);
    if (!Number.isNaN(when.getTime())) {
      filter.$and = [
        { $or: [{ startsAt: null }, { startsAt: { $lte: when } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gt: when } }] },
      ];
    }
  }

  const [items, total] = await Promise.all([
    applyQueryBudget(
      Promotion.find(filter)
        .sort({ priority: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ),
    applyQueryBudget(Promotion.countDocuments(filter)),
  ]);

  return ok(res, {
    items: items.map(normalizePromotionForOutput),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function getPromotion(req, res) {
  const id = req.params.id;
  const doc = await applyQueryBudget(Promotion.findById(id).lean());
  if (!doc) throw httpError(404, "PROMO_NOT_FOUND", "Promotion not found");
  return ok(res, { promotion: normalizePromotionForOutput(doc) });
}

export async function createPromotion(req, res) {
  const body = req.validated.body;
  const code = normalizeCodeOrNull(body.code);
  const value = body.value ?? (body.type === "FREE_SHIPPING" ? 0 : undefined);

  try {
    const doc = await Promotion.create({
      name: body.name,
      description: body.description || "",
      type: body.type,
      value,
      code,
      autoApply: body.autoApply ?? false,
      startsAt: parseDateOrNull(body.startsAt) ?? null,
      endsAt: parseDateOrNull(body.endsAt) ?? null,
      isActive: body.isActive ?? true,
      priority: body.priority ?? 0,
      stackingPolicy: body.stackingPolicy ?? "EXCLUSIVE",
      eligibility: normalizeEligibility(body.eligibility),
      scope: normalizeScope(body.scope),
      targeting: normalizeTargeting(body.targeting),
      limits: normalizeLimits(body.limits),
    });

    await logAuditSuccess(req, AuditActions.ADMIN_PROMOTION_CREATE, {
      type: "Promotion",
      id: String(doc._id),
    }, { message: `Created promotion: ${doc.name}` });

    return ok(res, { promotion: normalizePromotionForOutput(doc.toJSON ? doc.toJSON() : doc) }, 201);
  } catch (err) {
    if (err?.code === 11000) {
      await logAuditFail(req, AuditActions.ADMIN_PROMOTION_CREATE, {
        type: "Promotion",
      }, { message: "Promotion code already exists", code: "PROMO_CODE_EXISTS" });
      throw httpError(409, "PROMO_CODE_EXISTS", "Promotion code already exists");
    }
    await logAuditFail(req, AuditActions.ADMIN_PROMOTION_CREATE, { type: "Promotion" }, err);
    throw err;
  }
}

export async function updatePromotion(req, res) {
  const id = req.params.id;
  const body = req.validated.body;

  const existing = await Promotion.findById(id).lean();
  if (!existing) throw httpError(404, "PROMO_NOT_FOUND", "Promotion not found");

  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description || "";
  if (body.type !== undefined) patch.type = body.type;
  if (body.value !== undefined) patch.value = body.value;
  if (body.type === "FREE_SHIPPING" && body.value === undefined) patch.value = 0;
  if (body.code !== undefined) patch.code = normalizeCodeOrNull(body.code);
  if (body.autoApply !== undefined) patch.autoApply = !!body.autoApply;
  if (body.startsAt !== undefined) patch.startsAt = parseDateOrNull(body.startsAt);
  if (body.endsAt !== undefined) patch.endsAt = parseDateOrNull(body.endsAt);
  if (body.isActive !== undefined) patch.isActive = !!body.isActive;
  if (body.priority !== undefined) patch.priority = body.priority;
  if (body.stackingPolicy !== undefined) patch.stackingPolicy = body.stackingPolicy;

  if (body.eligibility !== undefined) patch.eligibility = normalizeEligibility(body.eligibility, existing.eligibility);
  if (body.scope !== undefined) patch.scope = normalizeScope(body.scope, existing.scope);
  if (body.targeting !== undefined) patch.targeting = normalizeTargeting(body.targeting, existing.targeting);
  if (body.limits !== undefined) patch.limits = normalizeLimits(body.limits, existing.limits);

  try {
    const doc = await Promotion.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
      context: "query",
    }).lean();

    await logAuditSuccess(req, AuditActions.ADMIN_PROMOTION_UPDATE, {
      type: "Promotion",
      id,
    }, { message: `Updated promotion: ${doc.name}` });

    return ok(res, { promotion: normalizePromotionForOutput(doc) });
  } catch (err) {
    if (err?.code === 11000) {
      await logAuditFail(req, AuditActions.ADMIN_PROMOTION_UPDATE, {
        type: "Promotion",
        id,
      }, { message: "Promotion code already exists", code: "PROMO_CODE_EXISTS" });
      throw httpError(409, "PROMO_CODE_EXISTS", "Promotion code already exists");
    }
    await logAuditFail(req, AuditActions.ADMIN_PROMOTION_UPDATE, { type: "Promotion", id }, err);
    throw err;
  }
}

export async function previewPromotion(req, res) {
  const id = req.params.id;
  const body = req.validated.body;

  const promo = await applyQueryBudget(Promotion.findById(id).lean());
  if (!promo) throw httpError(404, "PROMO_NOT_FOUND", "Promotion not found");

  const itemsIn = Array.isArray(body.items) ? body.items : [];
  const variantIds = [...new Set(itemsIn.map((i) => String(i.variantId)))];
  const variants = await applyQueryBudget(
    Variant.find({ _id: { $in: variantIds } }).select("_id productId price").lean(),
  );
  const vMap = new Map(variants.map((v) => [String(v._id), v]));

  const productIds = [...new Set(variants.map((v) => String(v.productId)))];
  const products = await applyQueryBudget(
    Product.find({ _id: { $in: productIds } }).select("brand categoryIds").lean(),
  );
  const pMap = new Map(products.map((p) => [String(p._id), p]));

  const ctxItems = [];
  let subtotalMinor = 0;
  for (const it of itemsIn) {
    const v = vMap.get(String(it.variantId));
    if (!v) throw httpError(400, "VARIANT_NOT_FOUND", "Variant not found");
    const qty = Number(it.quantity || 0);
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, "INVALID_QUANTITY", "Invalid quantity");

    const unitPriceMinor = Number.isInteger(it.unitPriceMinor) ? it.unitPriceMinor : Number(v.price || 0);
    if (!Number.isInteger(unitPriceMinor) || unitPriceMinor < 0) {
      throw httpError(400, "INVALID_MONEY_UNIT", "unitPriceMinor must be integer >= 0");
    }

    const lineSubtotalMinor = unitPriceMinor * qty;
    subtotalMinor += lineSubtotalMinor;

    const prod = pMap.get(String(v.productId)) || {};
    ctxItems.push({
      productId: v.productId,
      categoryIds: Array.isArray(prod.categoryIds) ? prod.categoryIds : [],
      brand: prod.brand || null,
      quantity: qty,
      unitPriceMinor,
      lineSubtotalMinor,
    });
  }

  const userId = body.userId || null;
  let roles = Array.isArray(body.roles) ? body.roles : [];
  let segments = Array.isArray(body.segments) ? body.segments : [];
  if (userId && (!roles.length || !segments.length)) {
    const user = await applyQueryBudget(
      User.findById(userId).select("roles segments").lean(),
    );
    if (!roles.length) roles = Array.isArray(user?.roles) ? user.roles : [];
    if (!segments.length) segments = Array.isArray(user?.segments) ? user.segments : [];
  }

  const evaluated = evaluatePromotions({
    promotions: [promo],
    ctx: {
      user: { userId, roles, segments },
      items: ctxItems,
      subtotalMinor,
      shippingMinor: body.shippingMinor,
      city: body.city || "",
      code: body.code || "",
    },
    includeIneligible: true,
  });

  const selected = selectPromotions(evaluated, { allowZero: true });

  return ok(res, {
    promotion: normalizePromotionForOutput(promo),
    evaluation: evaluated[0] || null,
    selected: selected.map((s) => ({
      promotionId: String(s.promotion?._id || ""),
      discountMinor: s.discountMinor || 0,
      reasons: s.reasons || [],
    })),
  });
}
