// src/utils/sales.js
// Sale helpers shared across home/products/pricing.
// Prompt rule:
// onSale = salePrice exists AND salePrice < price
// Optional: respect saleStartAt/saleEndAt window if present.

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function isSaleActiveByPrice(product, now = new Date()) {
  if (!product) return false;

  const price = toNumber(product.price);
  const salePrice = product.salePrice == null ? null : toNumber(product.salePrice);

  if (salePrice == null) return false;
  if (!(salePrice < price)) return false;

  // Optional date guards (only if provided)
  if (product.saleStartAt && now < new Date(product.saleStartAt)) return false;
  if (product.saleEndAt && now > new Date(product.saleEndAt)) return false;

  return true;
}

/**
 * Returns effective unit price based on the strict onSale rule:
 * If sale is active -> use salePrice
 * Otherwise -> use price
 *
 * NOTE: discountPercent is NOT used for pricing truth here.
 * (Keep it only for UI labels if you want.)
 */
export function getEffectiveUnitPrice(product, now = new Date()) {
  if (!product) return { unitPrice: 0, basePrice: 0, discount: 0, onSale: false };

  const basePrice = toNumber(product.price);

  if (isSaleActiveByPrice(product, now)) {
    const salePrice = toNumber(product.salePrice);
    const unitPrice = Math.max(0, Math.min(basePrice, salePrice));
    return {
      unitPrice,
      basePrice,
      discount: Math.max(0, basePrice - unitPrice),
      onSale: true,
    };
  }

  return { unitPrice: basePrice, basePrice, discount: 0, onSale: false };
}

/**
 * Helper: compute sale label percentage (for UI only).
 * Returns integer percent off (0..100) or null.
 */
export function computePercentOff(product) {
  if (!product) return null;
  const base = toNumber(product.price);
  const sale = product.salePrice == null ? null : toNumber(product.salePrice);
  if (sale == null || base <= 0 || sale >= base) return null;

  const pct = Math.round(((base - sale) / base) * 100);
  if (pct <= 0) return null;
  return Math.min(100, pct);
}
