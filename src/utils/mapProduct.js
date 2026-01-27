// src/utils/mapProduct.js

/**
 * Unified product DTO mappers for public API responses.
 * Ensures consistent shape across /products, /wishlist, /cart endpoints.
 */

function normalizeLang(lang) {
  return String(lang || "he").toLowerCase() === "ar" ? "ar" : "he";
}

function t(obj, field, lang) {
  const he = obj?.[`${field}He`] || obj?.[field] || "";
  const ar = obj?.[`${field}Ar`] || "";
  return lang === "ar" ? ar || he : he || ar;
}

function isSaleActiveByPrice(p, now = new Date()) {
  if (p?.salePrice == null) return false;
  if (!(Number(p.salePrice) < Number(p.price))) return false;
  if (p.saleStartAt && now < new Date(p.saleStartAt)) return false;
  if (p.saleEndAt && now > new Date(p.saleEndAt)) return false;
  return true;
}

function toMinorSafe(major) {
  const n = Number(major || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round((n + Number.EPSILON) * 100));
}

function mapProductImage(img, lang) {
  return {
    id: img?._id ? String(img._id) : null,
    url: img?.url || "",
    secureUrl: img?.secureUrl || img?.url || "",
    alt: lang === "ar" ? (img?.altAr || img?.altHe || "") : (img?.altHe || img?.altAr || ""),
    isPrimary: Boolean(img?.isPrimary),
    sortOrder: Number(img?.sortOrder || 0),
  };
}

function getMainImage(p) {
  if (Array.isArray(p.images) && p.images.length > 0) {
    const primary = p.images.find((img) => img.isPrimary);
    if (primary) {
      return primary.secureUrl || primary.url || p.imageUrl || "";
    }
    const first = p.images[0];
    return first?.secureUrl || first?.url || p.imageUrl || "";
  }
  return p.imageUrl || "";
}

/**
 * Map a product document to a list-item DTO shape.
 * Used by: GET /products, GET /wishlist, GET /cart
 */
export function mapProductListItem(p, { lang = "he", now = new Date() } = {}) {
  if (!p) return null;

  const L = normalizeLang(lang);
  const onSale = isSaleActiveByPrice(p, now);
  const images = Array.isArray(p.images) ? p.images.map((img) => mapProductImage(img, L)) : [];

  return {
    // ID normalization: include both _id and id
    _id: p._id,
    id: String(p._id),

    // Unified localized fields
    title: t(p, "title", L),
    description: t(p, "description", L),

    // Bilingual fields (additive)
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",
    descriptionHe: p.descriptionHe || p.description || "",
    descriptionAr: p.descriptionAr || "",

    // Pricing (major units)
    price: Number(p.price || 0),
    priceMinor: toMinorSafe(p.price),

    // Stock
    stock: Number(p.stock || 0),

    // Category
    categoryId: p.categoryId || null,

    // Images
    imageUrl: p.imageUrl || "",
    mainImage: getMainImage(p),
    images,

    // NOTE: isActive is intentionally NOT exposed in public API responses.
    // Ranking endpoints filter by isActive:true, so all returned products are active.
    // Exposing this field could leak internal state if a bug bypasses the filter.

    // Metadata
    brand: p.brand || "",
    sku: p.sku || "",
    barcode: p.barcode || "",
    sizeLabel: p.sizeLabel || "",
    unit: p.unit ?? null,
    netQuantity: p.netQuantity ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    slug: p.slug || "",

    // NOTE: isFeatured/isBestSeller removed from public API.
    // Rankings must be computed from real data via ranking endpoints.
    // See: NO MANUAL FLAGS store rule.

    // Sale block (only when active)
    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          salePriceMinor: toMinorSafe(p.salePrice),
          discountPercent: p.discountPercent ?? null,
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,
        }
      : null,
  };
}

/**
 * Map a product for cart item DTO.
 * Lighter than full product details, but consistent with list item shape.
 */
export function mapCartProductDTO(p, { lang = "he", now = new Date() } = {}) {
  if (!p) return null;

  const L = normalizeLang(lang);
  const onSale = isSaleActiveByPrice(p, now);
  const images = Array.isArray(p.images) ? p.images.map((img) => mapProductImage(img, L)) : [];

  return {
    // ID normalization
    _id: p._id,
    id: String(p._id),

    // Localized fields
    title: t(p, "title", L),
    titleHe: p.titleHe || p.title || "",
    titleAr: p.titleAr || "",

    // Pricing
    price: Number(p.price || 0),
    priceMinor: toMinorSafe(p.price),

    // Images
    imageUrl: p.imageUrl || "",
    mainImage: getMainImage(p),
    images,

    // Stock (product-level; cart may use variant stock)
    stock: Number(p.stock || 0),

    // Category
    categoryId: p.categoryId || null,

    // Slug for linking
    slug: p.slug || "",

    // Sale
    sale: onSale
      ? {
          salePrice: Number(p.salePrice || 0),
          salePriceMinor: toMinorSafe(p.salePrice),
          saleStartAt: p.saleStartAt || null,
          saleEndAt: p.saleEndAt || null,
        }
      : null,
  };
}

/**
 * Map a product for ranking cards (best-sellers / most-popular / top-rated).
 * Reuses list-item mapping for consistent shape.
 */
export function mapRankingProductCard(p, { lang = "he", now = new Date() } = {}) {
  return mapProductListItem(p, { lang, now });
}
