// src/utils/allocation.js

function parseBool(value, fallback = false) {
  const v = String(value ?? "").toLowerCase().trim();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function getThresholdBeforeVat() {
  const envVal = Number(process.env.ALLOCATION_THRESHOLD_BEFORE_VAT_ILS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;

  const cutoff = new Date("2026-06-01T00:00:00.000Z");
  const now = new Date();
  return now >= cutoff ? 5000 : 10000;
}

export function computeAllocationRequirement({ order, pricing } = {}) {
  const enabled = parseBool(process.env.ALLOCATION_ENABLED, true);
  const forceB2B = parseBool(process.env.ALLOCATION_FORCE, false);

  const companyName = String(order?.invoice?.customerCompanyName || "").trim();
  const vatId = String(order?.invoice?.customerVatId || "").trim();
  const isB2B = forceB2B || Boolean(companyName || vatId);

  const totalBeforeVat = Number(pricing?.totalBeforeVat ?? order?.pricing?.totalBeforeVat ?? 0);
  const thresholdBeforeVat = getThresholdBeforeVat();

  const required = Boolean(enabled && isB2B && totalBeforeVat >= thresholdBeforeVat);

  return {
    required,
    status: required ? "pending" : "none",
    thresholdBeforeVat,
  };
}
