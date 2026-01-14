// src/controllers/adminCoupons.controller.js
import { Coupon } from "../models/index.js";
import { ENV } from "../utils/env.js";
import { mapMoneyPairFromMinor, normalizeCurrency, toMinorUnitsInt } from "../utils/money.js";
import mongoose from "mongoose";
import { logAuditSuccess, logAuditFail, AuditActions } from "../services/audit.service.js";

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

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function requireObjectId(id, code = "INVALID_ID") {
  const v = String(id || "");
  if (!isValidObjectId(v)) throw httpError(400, code, code);
  return v;
}

function parseDateOrNull(v) {
  if (v === null) return null;
  if (typeof v === "string") return new Date(v);
  return undefined;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currency() {
  return normalizeCurrency(ENV.STRIPE_CURRENCY) || "ILS";
}

const MAX_MAJOR_AMOUNT = 1_000_000;

function ensureFiniteNumber(v, field) {
  if (!Number.isFinite(v)) {
    throw httpError(400, "COUPON_INVALID_NUMBER", `${field} must be a finite number`);
  }
  return v;
}

function ensureMajorRange(v, field) {
  const n = ensureFiniteNumber(Number(v), field);
  if (n < 0) throw httpError(400, "COUPON_INVALID", `${field} must be >= 0`);
  if (n > MAX_MAJOR_AMOUNT) {
    throw httpError(400, "COUPON_VALUE_TOO_LARGE", `${field} must be <= ${MAX_MAJOR_AMOUNT}`);
  }
  return n;
}

function ensureMinorRange(v, field, cur) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw httpError(400, "COUPON_INVALID_MINOR", `${field} must be integer (minor units) >= 0`);
  }
  const maxMinor = toMinorUnitsInt(MAX_MAJOR_AMOUNT, cur);
  if (n > maxMinor) {
    throw httpError(400, "COUPON_VALUE_TOO_LARGE", `${field} exceeds max allowed minor units`);
  }
  return n;
}

function parseMinorInput({ value, valueMinor, currency: cur, field, allowZero }) {
  if (valueMinor !== undefined && value !== undefined) {
    throw httpError(
      400,
      "COUPON_AMBIGUOUS_UNIT",
      `${field} and ${field}Minor cannot both be provided`,
    );
  }

  if (valueMinor !== undefined) {
    const minor = ensureMinorRange(valueMinor, `${field}Minor`, cur);
    if (!allowZero && minor <= 0) throw httpError(400, "COUPON_INVALID", `${field} must be > 0`);
    return minor;
  }

  if (value === undefined || value === null) return undefined;
  const major = ensureMajorRange(value, field);
  const minor = toMinorUnitsInt(major, cur);
  if (!allowZero && minor <= 0) throw httpError(400, "COUPON_INVALID", `${field} must be > 0`);
  return minor;
}

function parsePercentValue(value, valueMinor) {
  if (valueMinor !== undefined) {
    throw httpError(400, "COUPON_INVALID_UNIT", "Percent coupons cannot use valueMinor");
  }
  if (value === undefined || value === null) {
    throw httpError(400, "COUPON_VALUE_REQUIRED", "Percent coupon value is required");
  }

  const pct = ensureFiniteNumber(Number(value), "value");
  if (!(pct > 0 && pct <= 100)) {
    throw httpError(400, "COUPON_INVALID_PERCENT", "Percent coupon value must be in (0..100]");
  }
  return pct;
}

function parseFixedValue(body, cur) {
  const minor = parseMinorInput({
    value: body.value,
    valueMinor: body.valueMinor,
    currency: cur,
    field: "value",
    allowZero: false,
  });
  if (minor === undefined) {
    throw httpError(400, "COUPON_VALUE_REQUIRED", "Fixed coupon value is required");
  }
  return minor;
}

function parseMinOrderTotal(body, cur) {
  const minor = parseMinorInput({
    value: body.minOrderTotal,
    valueMinor: body.minOrderTotalMinor,
    currency: cur,
    field: "minOrderTotal",
    allowZero: true,
  });
  return minor ?? 0;
}

function normalizeAllowUserIds(ids) {
  if (!Array.isArray(ids)) return undefined;
  return ids.map((x) => String(x).trim());
}

function normalizeAllowedRoles(roles) {
  if (!Array.isArray(roles)) return undefined;
  const normalized = roles.map((r) => String(r || "").trim()).filter(Boolean);
  return [...new Set(normalized)];
}

function normalizeCouponForOutput(doc) {
  if (!doc) return doc;

  // NOTE: we keep DB field names as-is and only convert amounts to major units where applicable.
  const out = { ...doc };
  const cur = normalizeCurrency(out.currency) || currency();

  out.currency = cur;
  Object.assign(out, mapMoneyPairFromMinor(out.minOrderTotal ?? 0, cur, "minOrderTotal", "minOrderTotalMinor"));
  if (out.type === "fixed") {
    Object.assign(out, mapMoneyPairFromMinor(out.value ?? 0, cur, "value", "valueMinor"));
  } else {
    delete out.valueMinor;
  }
  if (Array.isArray(out.allowedUserIds)) out.allowedUserIds = out.allowedUserIds.map((id) => String(id));
  if (Array.isArray(out.allowedRoles)) out.allowedRoles = out.allowedRoles.map((r) => String(r));

  return out;
}

export async function createCoupon(req, res) {
  const body = req.validated.body;
  const cur = normalizeCurrency(body.currency) || currency();
  const allowedUserIds = normalizeAllowUserIds(body.allowedUserIds);
  const allowedRoles = normalizeAllowedRoles(body.allowedRoles);

  let value;
  if (body.type === "percent") {
    value = parsePercentValue(body.value, body.valueMinor);
  } else {
    value = parseFixedValue(body, cur);
  }

  const minOrderTotal = parseMinOrderTotal(body, cur);

  try {
    const doc = await Coupon.create({
      code: body.code,
      type: body.type,
      value,
      currency: cur,
      minOrderTotal,
      maxUsesTotal: body.maxUsesTotal ?? null,
      maxUsesPerUser: body.maxUsesPerUser ?? null,
      ...(allowedUserIds !== undefined ? { allowedUserIds } : {}),
      ...(allowedRoles !== undefined ? { allowedRoles } : {}),
      startsAt: parseDateOrNull(body.startsAt) ?? null,
      endsAt: parseDateOrNull(body.endsAt) ?? null,
      isActive: body.isActive ?? true,
    });

    const out = normalizeCouponForOutput(doc.toJSON ? doc.toJSON() : doc);

    await logAuditSuccess(req, AuditActions.ADMIN_COUPON_CREATE, {
      type: "Coupon",
      id: String(doc._id),
    }, { message: `Created coupon: ${body.code}` });

    return ok(res, { coupon: out }, 201);
  } catch (err) {
    if (err?.code === 11000) {
      await logAuditFail(req, AuditActions.ADMIN_COUPON_CREATE, {
        type: "Coupon",
      }, { message: "Coupon code already exists", code: "COUPON_CODE_EXISTS" });
      throw httpError(409, "COUPON_CODE_EXISTS", "Coupon code already exists");
    }
    await logAuditFail(req, AuditActions.ADMIN_COUPON_CREATE, { type: "Coupon" }, err);
    throw err;
  }
}

export async function listCoupons(req, res) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
  const q = String(req.query.q || "").trim().toUpperCase();
  const isActive = String(req.query.isActive || "").trim();

  const filter = {};
  if (q) filter.code = { $regex: escapeRegex(q) };
  if (isActive === "true") filter.isActive = true;
  if (isActive === "false") filter.isActive = false;

  const [items, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Coupon.countDocuments(filter),
  ]);

  return ok(res, {
    items: items.map(normalizeCouponForOutput),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}

export async function getCoupon(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_COUPON_ID");

  const doc = await Coupon.findById(id).lean();
  if (!doc) throw httpError(404, "COUPON_NOT_FOUND", "Coupon not found");

  return ok(res, { coupon: normalizeCouponForOutput(doc) });
}

export async function updateCoupon(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_COUPON_ID");
  const body = req.validated.body;

  const needsExisting =
    body.type === undefined ||
    body.currency === undefined ||
    body.value !== undefined ||
    body.valueMinor !== undefined ||
    body.minOrderTotal !== undefined ||
    body.minOrderTotalMinor !== undefined;

  const existing = needsExisting ? await Coupon.findById(id).lean() : null;
  if (needsExisting && !existing) throw httpError(404, "COUPON_NOT_FOUND", "Coupon not found");

  const effectiveType = body.type || existing?.type;
  const effectiveCurrency =
    normalizeCurrency(body.currency) ||
    normalizeCurrency(existing?.currency) ||
    currency();

  if (body.type !== undefined && body.value === undefined && body.valueMinor === undefined) {
    throw httpError(400, "COUPON_VALUE_REQUIRED", "Coupon value is required when changing type");
  }

  // Validate unit consistency for incoming changes
  if ((body.valueMinor !== undefined || body.value !== undefined) && effectiveType === "percent") {
    void parsePercentValue(body.value, body.valueMinor);
  }
  if ((body.valueMinor !== undefined || body.value !== undefined) && effectiveType === "fixed") {
    void parseFixedValue(body, effectiveCurrency);
  }

  const patch = {};
  for (const k of ["code", "type", "currency", "maxUsesTotal", "maxUsesPerUser", "isActive"]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.allowedUserIds !== undefined) {
    patch.allowedUserIds = normalizeAllowUserIds(body.allowedUserIds);
  }
  if (body.allowedRoles !== undefined) {
    patch.allowedRoles = normalizeAllowedRoles(body.allowedRoles);
  }

  if (patch.currency !== undefined) {
    patch.currency = normalizeCurrency(patch.currency) || "ILS";
  }
  if (body.startsAt !== undefined) patch.startsAt = parseDateOrNull(body.startsAt);
  if (body.endsAt !== undefined) patch.endsAt = parseDateOrNull(body.endsAt);

  if (body.minOrderTotal !== undefined || body.minOrderTotalMinor !== undefined) {
    patch.minOrderTotal = parseMinOrderTotal(body, effectiveCurrency);
  }

  if (body.value !== undefined || body.valueMinor !== undefined) {
    if (effectiveType === "percent") patch.value = parsePercentValue(body.value, body.valueMinor);
    if (effectiveType === "fixed") patch.value = parseFixedValue(body, effectiveCurrency);
  }

  try {
    const doc = await Coupon.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true, // ✅ important
      context: "query",
    }).lean();

    if (!doc) throw httpError(404, "COUPON_NOT_FOUND", "Coupon not found");

    await logAuditSuccess(req, AuditActions.ADMIN_COUPON_UPDATE, {
      type: "Coupon",
      id,
    }, { message: `Updated coupon: ${doc.code}` });

    return ok(res, { coupon: normalizeCouponForOutput(doc) });
  } catch (err) {
    if (err?.code === 11000) {
      await logAuditFail(req, AuditActions.ADMIN_COUPON_UPDATE, {
        type: "Coupon",
        id,
      }, { message: "Coupon code already exists", code: "COUPON_CODE_EXISTS" });
      throw httpError(409, "COUPON_CODE_EXISTS", "Coupon code already exists");
    }
    await logAuditFail(req, AuditActions.ADMIN_COUPON_UPDATE, { type: "Coupon", id }, err);
    throw err;
  }
}

export async function deactivateCoupon(req, res) {
  const id = requireObjectId(req.params.id, "INVALID_COUPON_ID");

  try {
    const doc = await Coupon.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true, context: "query" },
    ).lean();

    if (!doc) throw httpError(404, "COUPON_NOT_FOUND", "Coupon not found");

    await logAuditSuccess(req, AuditActions.ADMIN_COUPON_DEACTIVATE, {
      type: "Coupon",
      id,
    }, { message: `Deactivated coupon: ${doc.code}` });

    // ✅ normalize output (includes major units conversion)
    return ok(res, { coupon: normalizeCouponForOutput(doc) });
  } catch (err) {
    await logAuditFail(req, AuditActions.ADMIN_COUPON_DEACTIVATE, { type: "Coupon", id }, err);
    throw err;
  }
}
