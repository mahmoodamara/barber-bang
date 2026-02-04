// src/scripts/seed.utils.js
// Shared helpers for seed: env validation, money/slug helpers, Order-schema–compatible builders.
// Server is source of truth; these produce values that pass model validation.

/**
 * Convert ILS major units to minor (agorot). Safe for schema defaults.
 */
export function toMinorSafe(major) {
  const n = Number(major ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

/**
 * Date at midnight (local) plus N days. Used for startAt/endAt in promos.
 */
export function nowPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

/**
 * URL-safe slug from SKU (for optional slug hint before Product pre-validate overwrites).
 */
export function slugFromSku(sku) {
  return String(sku || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * STRICT: Seed is disabled in production. No override.
 */
export function mustNotRunInProd() {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    console.error("❌ Seed is disabled in production.");
    process.exit(1);
  }
}

/**
 * Require seed env vars; exit 1 with clear message if any missing.
 * Never log plaintext passwords.
 */
export function validateSeedEnv() {
  const required = [
    "SEED_ADMIN_EMAIL",
    "SEED_ADMIN_PASSWORD",
    "SEED_STAFF_EMAIL",
    "SEED_STAFF_PASSWORD",
    "SEED_TEST_EMAIL",
    "SEED_TEST_PASSWORD",
  ];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) {
    console.error(`Missing required env for seed: ${missing.join(", ")}. Set them before running seed.`);
    process.exit(1);
  }
}

/**
 * Build Order.pricing object matching Order schema (required: subtotal, shippingFee, total).
 * Optional: couponCode, couponAmount, campaignAmount, campaignId, offerAmount.
 * discountTotal/couponCode are also set by Order pre-validate; we set them for clarity.
 */
export function buildOrderPricing({
  subtotal,
  shippingFee,
  total,
  couponCode = null,
  couponAmount = 0,
  campaignAmount = 0,
  campaignId = null,
  offerAmount = 0,
}) {
  const discountTotal = Math.max(0, (couponAmount || 0) + (campaignAmount || 0) + (offerAmount || 0));
  return {
    subtotal: Number(subtotal) || 0,
    shippingFee: Number(shippingFee) || 0,
    total: Number(total) || 0,
    discounts: {
      coupon: { code: couponCode ?? null, amount: Number(couponAmount) || 0 },
      campaign: { amount: Number(campaignAmount) || 0 },
      offer: { amount: Number(offerAmount) || 0 },
    },
    discountTotal,
    couponCode: String(couponCode || "").trim(),
    campaignId: campaignId ?? null,
    vatRate: 0,
    vatAmount: 0,
    totalBeforeVat: 0,
    totalAfterVat: 0,
    vatIncludedInPrices: false,
    subtotalMinor: toMinorSafe(subtotal),
    shippingFeeMinor: toMinorSafe(shippingFee),
    discountTotalMinor: toMinorSafe(discountTotal),
    totalMinor: toMinorSafe(total),
    vatAmountMinor: 0,
    totalBeforeVatMinor: 0,
    totalAfterVatMinor: 0,
  };
}

/**
 * Build Order.shipping object matching Order schema (required: mode).
 * mode: "DELIVERY" | "PICKUP_POINT" | "STORE_PICKUP"
 * Address and optional deliveryAreaName/pickupPointName/pickupPointAddress have safe defaults.
 */
export function buildOrderShipping({
  mode,
  phone = "",
  fullName = "",
  city = "",
  street = "",
  building = "",
  floor = "",
  apartment = "",
  entrance = "",
  notes = "",
  deliveryAreaId = null,
  deliveryAreaName = "",
  pickupPointId = null,
  pickupPointName = "",
  pickupPointAddress = "",
}) {
  const address = {
    fullName: String(fullName || "").trim(),
    phone: String(phone || "").trim(),
    city: String(city || "").trim(),
    street: String(street || "").trim(),
    building: String(building || "").trim(),
    floor: String(floor || "").trim(),
    apartment: String(apartment || "").trim(),
    entrance: String(entrance || "").trim(),
    notes: String(notes || "").trim(),
  };
  return {
    mode,
    deliveryAreaId: deliveryAreaId ?? null,
    pickupPointId: pickupPointId ?? null,
    deliveryAreaName: String(deliveryAreaName || "").trim(),
    pickupPointName: String(pickupPointName || "").trim(),
    pickupPointAddress: String(pickupPointAddress || "").trim(),
    carrier: "",
    trackingNumber: "",
    phone: String(phone || "").trim(),
    address,
  };
}

/**
 * Get next order number in same format as checkout (BB-YYYY-NNNNNN).
 * Requires Counter model and optionally a session. Caller must ensure Counter is seeded.
 */
export async function getNextOrderNumber(Counter, session = null) {
  const year = new Date().getFullYear();
  const key = "order";
  const opts = session ? { session } : {};
  const counter = await Counter.findOneAndUpdate(
    { key, year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...opts }
  );
  const seq = Number(counter?.seq ?? 0);
  const padded = String(Math.max(0, seq)).padStart(6, "0");
  return `BB-${year}-${padded}`;
}
