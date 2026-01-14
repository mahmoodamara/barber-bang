// src/services/adminShipping.service.js
import { ShippingMethod } from "../models/index.js";
import { ENV } from "../utils/env.js";
import { mapMoneyPairFromMinor, normalizeCurrency, toMinorUnitsInt } from "../utils/money.js";

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function currencyOrDefault(cur) {
  return normalizeCurrency(cur || ENV.STRIPE_CURRENCY) || "ILS";
}

function normalizeCity(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeCities(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const set = new Set(list.map(normalizeCity).filter(Boolean));
  return Array.from(set).slice(0, 500);
}

function majorToMinorOrNull(vMajor, field, cur) {
  if (vMajor === null || vMajor === undefined) return null;
  const n = Number(vMajor);
  if (!Number.isFinite(n) || n < 0) {
    throw httpError(400, "INVALID_MONEY", `${field} must be a finite number >= 0`);
  }
  const minor = toMinorUnitsInt(n, cur);
  if (!Number.isInteger(minor) || minor < 0) {
    throw httpError(400, "INVALID_MONEY_UNIT", `${field} must be integer (minor units) >= 0`);
  }
  return minor;
}

function toDTO(docOrLean) {
  if (!docOrLean) return docOrLean;
  const d = typeof docOrLean.toObject === "function" ? docOrLean.toObject() : docOrLean;
  const {
    _id,
    basePrice,
    freeAbove,
    minSubtotal,
    maxSubtotal,
    ...rest
  } = d;
  const currency = normalizeCurrency(ENV.STRIPE_CURRENCY) || "ILS";
  return {
    ...rest,
    id: String(_id),
    ...mapMoneyPairFromMinor(basePrice ?? 0, currency, "basePrice", "basePriceMinor"),
    ...mapMoneyPairFromMinor(freeAbove, currency, "freeAbove", "freeAboveMinor"),
    ...mapMoneyPairFromMinor(minSubtotal, currency, "minSubtotal", "minSubtotalMinor"),
    ...mapMoneyPairFromMinor(maxSubtotal, currency, "maxSubtotal", "maxSubtotalMinor"),
    currency,
  };
}

export async function adminListShippingMethods({ q }) {
  const page = Math.max(1, Number(q.page || 1));
  const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
  const skip = (page - 1) * limit;

  const filter = {};

  const search = String(q.q || "").trim();
  if (search) {
    filter.$or = [
      { code: { $regex: search, $options: "i" } },
      { nameHe: { $regex: search, $options: "i" } },
      { nameAr: { $regex: search, $options: "i" } },
    ];
  }

  if (q.isActive === "true") filter.isActive = true;
  if (q.isActive === "false") filter.isActive = false;

  const [items, total] = await Promise.all([
    ShippingMethod.find(filter).sort({ sort: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ShippingMethod.countDocuments(filter),
  ]);

  return {
    items: items.map(toDTO),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

export async function adminGetShippingMethod(id) {
  const doc = await ShippingMethod.findById(id).lean();
  if (!doc) throw httpError(404, "SHIPPING_METHOD_NOT_FOUND", "Shipping method not found");
  return toDTO(doc);
}

export async function adminCreateShippingMethod(body) {
  const cur = currencyOrDefault(body.currency);

  const code = String(body.code || "").trim().toUpperCase();
  if (!code) throw httpError(400, "INVALID_CODE", "code is required");

  const doc = await ShippingMethod.create({
    code,
    nameHe: String(body.nameHe || "").trim(),
    nameAr: String(body.nameAr || "").trim(),
    descHe: String(body.descHe || "").trim(),
    descAr: String(body.descAr || "").trim(),

    basePrice: majorToMinorOrNull(body.basePrice, "basePrice", cur) ?? 0,
    freeAbove: majorToMinorOrNull(body.freeAbove, "freeAbove", cur),
    minSubtotal: majorToMinorOrNull(body.minSubtotal, "minSubtotal", cur),
    maxSubtotal: majorToMinorOrNull(body.maxSubtotal, "maxSubtotal", cur),

    cities: normalizeCities(body.cities),
    sort: Number.isInteger(body.sort) ? body.sort : 100,
    isActive: body.isActive ?? true,
  });

  return toDTO(doc);
}

export async function adminUpdateShippingMethod(id, patch) {
  const doc = await ShippingMethod.findById(id);
  if (!doc) throw httpError(404, "SHIPPING_METHOD_NOT_FOUND", "Shipping method not found");

  const cur = currencyOrDefault(patch.currency);

  const setIf = (k, v) => {
    if (v !== undefined) doc[k] = v;
  };

  if (patch.code !== undefined) setIf("code", String(patch.code).trim().toUpperCase());
  if (patch.nameHe !== undefined) setIf("nameHe", String(patch.nameHe).trim());
  if (patch.nameAr !== undefined) setIf("nameAr", String(patch.nameAr).trim());
  if (patch.descHe !== undefined) setIf("descHe", String(patch.descHe).trim());
  if (patch.descAr !== undefined) setIf("descAr", String(patch.descAr).trim());

  if (patch.basePrice !== undefined) doc.basePrice = majorToMinorOrNull(patch.basePrice, "basePrice", cur) ?? 0;
  if (patch.freeAbove !== undefined) doc.freeAbove = majorToMinorOrNull(patch.freeAbove, "freeAbove", cur);
  if (patch.minSubtotal !== undefined) doc.minSubtotal = majorToMinorOrNull(patch.minSubtotal, "minSubtotal", cur);
  if (patch.maxSubtotal !== undefined) doc.maxSubtotal = majorToMinorOrNull(patch.maxSubtotal, "maxSubtotal", cur);

  if (patch.cities !== undefined) doc.cities = normalizeCities(patch.cities);

  setIf("sort", patch.sort);
  setIf("isActive", patch.isActive);

  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw httpError(409, "SHIPPING_CODE_EXISTS", "Shipping method code already exists");
    }
    throw err;
  }

  return toDTO(doc);
}

export async function adminDeactivateShippingMethod(id) {
  const doc = await ShippingMethod.findByIdAndUpdate(id, { isActive: false }, { new: true }).lean();
  if (!doc) throw httpError(404, "SHIPPING_METHOD_NOT_FOUND", "Shipping method not found");
  return toDTO(doc);
}
