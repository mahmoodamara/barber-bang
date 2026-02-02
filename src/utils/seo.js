// src/utils/seo.js
// SEO helper utilities for URL building, metadata generation, and XML escaping.

/**
 * Environment-based configuration with fallbacks
 */
export const STORE_BASE_URL = (
  process.env.STORE_BASE_URL ||
  process.env.FRONTEND_URL ||
  process.env.CLIENT_URL ||
  "https://barber-bang.netlify.app"
).replace(/\/+$/, "");

export const STORE_OG_IMAGE_URL =
  process.env.STORE_OG_IMAGE_URL || `${STORE_BASE_URL}/og-default.jpg`;

export const STORE_NAME_HE = process.env.STORE_NAME_HE || "החנות שלנו";
export const STORE_NAME_AR = process.env.STORE_NAME_AR || "متجرنا";

/**
 * Build canonical URL for a given path
 * @param {string} path - Path without leading slash (e.g., "product/slug")
 * @param {string|null} lang - Optional language for query param
 * @returns {string} Full canonical URL
 */
export function buildCanonicalUrl(path, lang = null) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const url = cleanPath ? `${STORE_BASE_URL}/${cleanPath}` : STORE_BASE_URL;
  return lang ? `${url}?lang=${lang}` : url;
}

/**
 * Build alternate language URLs (hreflang)
 * @param {string} path - Path without leading slash
 * @returns {{ he: string, ar: string, xDefault: string }}
 */
export function buildAlternates(path) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  const fullPath = cleanPath ? `${STORE_BASE_URL}/${cleanPath}` : STORE_BASE_URL;

  return {
    he: `${fullPath}?lang=he`,
    ar: `${fullPath}?lang=ar`,
    xDefault: fullPath,
  };
}

/**
 * Build Open Graph metadata object
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.description
 * @param {string} [options.image]
 * @param {string} [options.url]
 * @param {string} [options.type] - "website" | "product"
 * @param {string} [options.lang] - "he" | "ar"
 * @returns {object} Open Graph metadata
 */
export function buildOgMeta(options) {
  const { title, description, image, url, type = "website", lang } = options;
  return {
    title: title || "",
    description: description || "",
    image: image || STORE_OG_IMAGE_URL,
    url: url || STORE_BASE_URL,
    type,
    locale: lang === "ar" ? "ar_IL" : "he_IL",
  };
}

/**
 * Build Twitter Card metadata object
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.description
 * @param {string} [options.image]
 * @returns {object} Twitter Card metadata
 */
export function buildTwitterMeta(options) {
  const { title, description, image } = options;
  return {
    card: "summary_large_image",
    title: title || "",
    description: description || "",
    image: image || STORE_OG_IMAGE_URL,
  };
}

/**
 * Truncate text to SEO-friendly lengths
 * @param {string} text - Text to truncate
 * @param {number} [maxLen=160] - Maximum length
 * @returns {string} Truncated text
 */
export function truncateSeoText(text, maxLen = 160) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean;
  // Truncate at word boundary if possible
  const truncated = clean.slice(0, maxLen - 3);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }
  return truncated.trim() + "...";
}

/**
 * Get primary image URL from product with fallback
 * @param {object} product - Product document (lean)
 * @returns {string} Image URL
 */
export function getProductImageUrl(product) {
  if (Array.isArray(product?.images) && product.images.length > 0) {
    // Find primary image first
    const primary = product.images.find((img) => img.isPrimary);
    const img = primary || product.images[0];
    return img?.secureUrl || img?.url || product?.imageUrl || STORE_OG_IMAGE_URL;
  }
  return product?.imageUrl || STORE_OG_IMAGE_URL;
}

/**
 * Get category image URL with fallback
 * @param {object} category - Category document (lean)
 * @returns {string} Image URL
 */
export function getCategoryImageUrl(category) {
  return category?.bannerUrl || category?.imageUrl || STORE_OG_IMAGE_URL;
}

/**
 * Escape XML special characters for sitemap generation
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format date to W3C format for sitemaps (YYYY-MM-DD)
 * @param {Date|string} date - Date to format
 * @returns {string|null} W3C formatted date or null
 */
export function toW3CDate(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

/**
 * Get store name based on language
 * @param {string} lang - "he" | "ar"
 * @returns {string} Store name
 */
export function getStoreName(lang) {
  return lang === "ar" ? STORE_NAME_AR : STORE_NAME_HE;
}
