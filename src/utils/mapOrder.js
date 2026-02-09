// src/utils/mapOrder.js

/** ILS/Shekel symbol for invoice and display */
export const CURRENCY_SYMBOL_ILS = "\u20AA"; // ₪

/**
 * Format a numeric price with Shekel symbol (e.g. "123.45 ₪")
 * @param {number} value - Amount in major units (ILS)
 * @returns {string}
 */
export function formatPriceILS(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `0.00 ${CURRENCY_SYMBOL_ILS}`;
  const fixed = n.toFixed(2);
  return `${fixed} ${CURRENCY_SYMBOL_ILS}`;
}

function normalizeLang(lang) {
  return String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";
}

function pickTitle(it, lang) {
  const he = String(it?.titleHe || it?.title || "");
  const ar = String(it?.titleAr || "");
  return lang === "ar" ? ar || he : he || ar;
}

function mapLine(it, lang) {
  const unitPrice = Number(it?.unitPrice ?? it?.price ?? 0);
  const qty = Number(it?.qty ?? 1);
  const lineTotal = unitPrice * qty;
  return {
    ...it,
    titleHe: String(it?.titleHe || it?.title || ""),
    titleAr: String(it?.titleAr || ""),
    title: pickTitle(it, lang),
    unitPriceFormatted: formatPriceILS(unitPrice),
    lineTotalFormatted: formatPriceILS(lineTotal),
  };
}

export function mapOrder(order, { lang } = {}) {
  if (!order) return null;

  const obj =
    typeof order.toObject === "function" ? order.toObject({ virtuals: true }) : { ...order };
  const L = normalizeLang(lang);

  const items = Array.isArray(obj.items) ? obj.items.map((it) => mapLine(it, L)) : [];
  const gifts = Array.isArray(obj.gifts) ? obj.gifts.map((it) => mapLine(it, L)) : [];

  const id = obj?._id ? String(obj._id) : String(obj.id || "");

  // Ensure shipping includes carrier and trackingNumber for API responses
  const shipping = obj.shipping
    ? {
      ...obj.shipping,
      carrier: obj.shipping.carrier || "",
      trackingNumber: obj.shipping.trackingNumber || "",
    }
    : null;

  // Pricing with Shekel (₪) formatted fields for invoice/display
  const rawPricing = obj.pricing || {};
  const pricing = {
    ...rawPricing,
    currencySymbol: CURRENCY_SYMBOL_ILS,
    subtotalFormatted: formatPriceILS(rawPricing.subtotal),
    shippingFeeFormatted: formatPriceILS(rawPricing.shippingFee),
    totalFormatted: formatPriceILS(rawPricing.total),
    totalBeforeVatFormatted: formatPriceILS(rawPricing.totalBeforeVat),
    totalAfterVatFormatted: formatPriceILS(rawPricing.totalAfterVat),
    vatAmountFormatted: formatPriceILS(rawPricing.vatAmount),
  };

  return {
    ...obj,
    id,
    items,
    gifts,
    shipping,
    pricing,
  };
}

