import { ENV } from "../utils/env.js";

function ensureMinorInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error("INVALID_MONEY_UNIT");
    err.statusCode = 500;
    err.code = "INVALID_MONEY_UNIT";
    err.details = { field, value: v };
    throw err;
  }
  return n;
}

function normalizeCountryCode(country) {
  const raw = String(country || "").trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (lower === "israel") return "IL";

  // If already a country code, normalize to ISO-style upper
  if (/^[a-zA-Z]{2}$/.test(raw)) return raw.toUpperCase();

  // If caller passes something else (e.g. "Israel (IL)"), try a safe heuristic
  const m = raw.match(/\b([A-Za-z]{2})\b/);
  if (m?.[1]) return String(m[1]).toUpperCase();

  return raw.toUpperCase().slice(0, 2);
}

function normalizeCityKey(city) {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120) || null;
}

function resolveVatBps({ cityKey } = {}) {
  const base = Number(ENV.VAT_BPS ?? 0);
  const baseBps = Number.isInteger(base) && base >= 0 && base <= 10_000 ? base : 0;

  const overrides = ENV.CITY_RATE_OVERRIDES && typeof ENV.CITY_RATE_OVERRIDES === "object"
    ? ENV.CITY_RATE_OVERRIDES
    : {};

  if (cityKey && Number.isInteger(overrides[cityKey])) {
    const bps = Number(overrides[cityKey]);
    if (bps >= 0 && bps <= 10_000) return bps;
  }

  return baseBps;
}

function mulBpsRound(amountMinor, bps) {
  // amount * (bps / 10000), rounded to nearest minor unit
  return Math.round((Number(amountMinor) * Number(bps)) / 10_000);
}

/**
 * computeTax (VAT)
 *
 * Production-safe minimal policy:
 * - Client never sends tax; backend is source of truth.
 * - Shipping is treated as taxable by default (included in basis).
 * - If shippingAddress.country != TAX_COUNTRY => tax=0
 *
 * Returns:
 * - taxMinor: integer minor units
 * - taxRateBps: basis points used (0..10000)
 * - taxBasisMinor: base used (0 if not taxable)
 * - taxCountrySnapshot/taxCitySnapshot: normalized values used for the decision
 */
export function computeTax({
  itemsSubtotalMinor,
  discountMinor = 0,
  shippingMinor = 0,
  shippingAddress = null,
} = {}) {
  const enabled = ENV.TAX_ENABLED !== false;

  const subtotal = ensureMinorInt(itemsSubtotalMinor ?? 0, "itemsSubtotalMinor");
  const discount = ensureMinorInt(discountMinor ?? 0, "discountMinor");
  const shipping = ensureMinorInt(shippingMinor ?? 0, "shippingMinor");

  const taxCountry = String(ENV.TAX_COUNTRY || "IL").trim().toUpperCase();
  const countrySnapshot = normalizeCountryCode(shippingAddress?.country);
  const cityKey = normalizeCityKey(shippingAddress?.city);

  if (!enabled) {
    return {
      taxMinor: 0,
      taxRateBps: 0,
      taxBasisMinor: 0,
      taxCountrySnapshot: countrySnapshot,
      taxCitySnapshot: cityKey ? String(shippingAddress?.city || "").trim().slice(0, 120) : null,
    };
  }

  // Apply tax only for matching country
  if (!countrySnapshot || countrySnapshot !== taxCountry) {
    return {
      taxMinor: 0,
      taxRateBps: 0,
      taxBasisMinor: 0,
      taxCountrySnapshot: countrySnapshot,
      taxCitySnapshot: cityKey ? String(shippingAddress?.city || "").trim().slice(0, 120) : null,
    };
  }

  const basis = Math.max(0, subtotal - discount + shipping);
  const rateBps = resolveVatBps({ cityKey });
  const taxMinor = Math.max(0, mulBpsRound(basis, rateBps));

  return {
    taxMinor,
    taxRateBps: rateBps,
    taxBasisMinor: basis,
    taxCountrySnapshot: countrySnapshot,
    taxCitySnapshot: cityKey ? String(shippingAddress?.city || "").trim().slice(0, 120) : null,
  };
}
