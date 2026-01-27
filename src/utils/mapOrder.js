// src/utils/mapOrder.js

function normalizeLang(lang) {
  return String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";
}

function pickTitle(it, lang) {
  const he = String(it?.titleHe || it?.title || "");
  const ar = String(it?.titleAr || "");
  return lang === "ar" ? ar || he : he || ar;
}

function mapLine(it, lang) {
  return {
    ...it,
    titleHe: String(it?.titleHe || it?.title || ""),
    titleAr: String(it?.titleAr || ""),
    title: pickTitle(it, lang),
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

  return {
    ...obj,
    id,
    items,
    gifts,
    shipping,
  };
}

