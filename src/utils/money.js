/**
 * Money contract:
 * - All internal values are integer minor units.
 * - API responses keep existing major fields and add explicit `*Minor` twins.
 */
import { ENV } from "./env.js";
import { evaluateCoupon } from "../services/coupon.service.js";
import { normalizeCurrency as normalizeCurrencyRaw, toMinorUnits, ensureMinorUnitsInt } from "./stripe.js";

const ZERO_DECIMAL = new Set(["JPY", "KRW"]);

function httpError(statusCode, code, message, details) {
  const err = new Error(message || code);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

export function normalizeCurrency(input) {
  // Money contract: normalize all variants to ILS for output consistency.
  normalizeCurrencyRaw(input);
  return "ILS";
}

export function assertIntMinor(value, path = "amountMinor") {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, "INVALID_MONEY_UNIT", `${path} must be integer (minor units) >= 0`, {
      path,
    });
  }
}

export function ensureMinorInt(n, field = "amount") {
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error("INVALID_MONEY_UNIT");
    err.statusCode = 400;
    err.details = { field };
    throw err;
  }
}

export function toMajorUnits(value, currency) {
  if (value === null || value === undefined) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const c = normalizeCurrency(currency) || "ILS";
  if (ZERO_DECIMAL.has(c)) return n;
  return Number((n / 100).toFixed(2));
}

export function toMinorUnitsInt(value, currency) {
  const minor = toMinorUnits(value, currency);
  ensureMinorUnitsInt(minor);
  return minor;
}

export function toMinorUnitsSafe(value, currency) {
  if (value === null || value === undefined || value === "") return null;
  const minor = toMinorUnits(value, currency);
  if (!Number.isInteger(minor) || minor < 0) return null;
  return minor;
}

export function mapMoneyPairFromMinor(minor, currency, majorKey, minorKey) {
  const mKey = majorKey || "amount";
  const nKey = minorKey || `${mKey}Minor`;
  assertIntMinor(minor, nKey);
  const cur = normalizeCurrency(currency);
  return {
    [mKey]: toMajorUnits(minor, cur),
    [nKey]: minor ?? null,
  };
}

export function mapMoneyPairFromMajor(major, currency, majorKey, minorKey) {
  const mKey = majorKey || "amount";
  const nKey = minorKey || `${mKey}Minor`;
  if (major === null || major === undefined) {
    return { [mKey]: major ?? null, [nKey]: null };
  }
  const cur = normalizeCurrency(currency);
  const minor = toMinorUnitsInt(major, cur);
  assertIntMinor(minor, nKey);
  return {
    [mKey]: major ?? null,
    [nKey]: minor,
  };
}

export function toMoneyDTO(minor, currency) {
  assertIntMinor(minor, "amountMinor");
  return {
    amountMinor: minor ?? null,
    amount: minor === null || minor === undefined ? null : toMajorUnits(minor, currency),
    currency: normalizeCurrency(currency),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function assertMoneyContractOnResponse(payload) {
  const seen = new WeakSet();

  const walk = (value, path) => {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        walk(value[i], `${path}[${i}]`);
      }
      return;
    }

    if (!isPlainObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, val] of Object.entries(value)) {
      if (key.endsWith("Minor") || key.endsWith("_Minor")) {
        assertIntMinor(val, path ? `${path}.${key}` : key);
      }

      if (key === "currency" || key.endsWith("Currency")) {
        if (val !== null && val !== undefined && String(val).toUpperCase() !== "ILS") {
          throw httpError(500, "MONEY_CONTRACT_CURRENCY", `${key} must be ILS`, {
            path: path ? `${path}.${key}` : key,
            value: val,
          });
        }
      }

      walk(val, path ? `${path}.${key}` : key);
    }
  };

  walk(payload, "");
  return payload;
}

export async function computeTotals({ items, couponCode }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error("EMPTY_CART");
    err.statusCode = 400;
    throw err;
  }

  let subtotal = 0;
  let currency = normalizeCurrency(items[0]?.currency || ENV.STRIPE_CURRENCY || "ILS");

  for (const it of items) {
    ensureMinorInt(it.unitPrice, "items[].unitPrice");
    ensureMinorInt(it.quantity, "items[].quantity");
    ensureMinorInt(it.lineTotal, "items[].lineTotal");

    currency = normalizeCurrency(it.currency || currency);
    subtotal += it.lineTotal;
  }

  ensureMinorInt(subtotal, "pricing.subtotal");

  const couponEval = await evaluateCoupon({ code: couponCode, subtotal, currency });
  const discount = couponEval.ok ? couponEval.discountTotal : 0;

  const shipping = 0; // MVP
  const total = Math.max(0, subtotal - discount + shipping);

  return {
    currency,
    subtotal,
    discount,
    shipping,
    total,
    coupon: couponEval.ok ? couponEval.code : null,
    couponError: couponEval.ok ? null : couponEval.reason,
  };
}
