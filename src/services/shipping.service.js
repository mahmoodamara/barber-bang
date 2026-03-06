// src/services/shipping.service.js
// Pure business logic for shipping cost calculation.
// All pricing rules live in the DB — no hardcoded thresholds here.

import { ShippingConfig } from "../models/ShippingConfig.js";
import { log } from "../utils/logger.js";

const VALID_CUSTOMER_TYPES = ["retail", "wholesale"];

// ─── In-process config cache (1 min TTL) ──────────────────────────────────
// Avoids a DB round-trip on every calculation while staying fresh enough for
// admin changes to propagate quickly.
let _cache = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Fetch the shipping config singleton from MongoDB.
 * Creates a default document on first boot if none exists.
 *
 * @returns {Promise<object>} Lean ShippingConfig document
 */
export async function getShippingConfig() {
  const now = Date.now();
  if (_cache && now - _cachedAt < CACHE_TTL_MS) return _cache;

  let config = await ShippingConfig.findOne().lean();

  if (!config) {
    log.info("[shipping] No config found — seeding defaults");
    const created = await ShippingConfig.create({
      freeShippingThreshold: { retail: 400, wholesale: 1000 },
      baseShippingPrice:     { retail: 30,  wholesale: 50  },
    });
    config = created.toObject();
  }

  _cache    = config;
  _cachedAt = now;
  return config;
}

/**
 * Bust the in-process config cache.
 * Call this after an admin updates the shipping config so the next request
 * picks up the fresh values immediately.
 */
export function invalidateShippingConfigCache() {
  _cache    = null;
  _cachedAt = 0;
}

/**
 * Calculate the shipping cost for a given customer type and order total.
 *
 * Rules (all sourced from DB):
 *   - retail    customers: free if orderTotal >= freeShippingThreshold.retail
 *   - wholesale customers: free if orderTotal >= freeShippingThreshold.wholesale
 *   - Otherwise: flat baseShippingPrice[customerType] is charged
 *
 * @param {"retail"|"wholesale"} customerType
 * @param {number} orderTotal  Positive number in currency units (e.g. 450.00)
 * @returns {Promise<ShippingResult>}
 *
 * @typedef {object} ShippingResult
 * @property {"retail"|"wholesale"} customerType
 * @property {number} orderTotal
 * @property {number} shippingCost       0 when free, otherwise baseShippingPrice
 * @property {boolean} isFreeShipping
 * @property {number} freeShippingThreshold  The threshold that was applied
 * @property {number} baseShippingPrice      The base price that was applied
 */
export async function calculateShipping(customerType, orderTotal) {
  // ── Input validation ───────────────────────────────────────────────────
  if (!VALID_CUSTOMER_TYPES.includes(customerType)) {
    const err = new Error(
      `Invalid customerType "${customerType}". Must be one of: ${VALID_CUSTOMER_TYPES.join(", ")}.`
    );
    err.statusCode = 400;
    err.code = "INVALID_CUSTOMER_TYPE";
    throw err;
  }

  const total = Number(orderTotal);
  if (!Number.isFinite(total) || total < 0) {
    const err = new Error("orderTotal must be a non-negative finite number.");
    err.statusCode = 400;
    err.code = "INVALID_ORDER_TOTAL";
    throw err;
  }

  // ── Fetch rules from DB (cached) ───────────────────────────────────────
  const config = await getShippingConfig();

  const threshold  = config.freeShippingThreshold[customerType];
  const basePrice  = config.baseShippingPrice[customerType];

  const isFreeShipping = total >= threshold;
  const shippingCost   = isFreeShipping ? 0 : basePrice;

  return {
    customerType,
    orderTotal:           total,
    shippingCost,
    isFreeShipping,
    freeShippingThreshold: threshold,
    baseShippingPrice:     basePrice,
  };
}
