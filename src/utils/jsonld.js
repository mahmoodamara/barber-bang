// src/utils/jsonld.js
// Schema.org JSON-LD builders for structured data.

import { t } from "./i18n.js";
import {
  STORE_BASE_URL,
  STORE_OG_IMAGE_URL,
  STORE_NAME_HE,
  STORE_NAME_AR,
  buildCanonicalUrl,
  getProductImageUrl,
  getCategoryImageUrl,
  getStoreName,
} from "./seo.js";

/**
 * Build Product JSON-LD schema
 * @see https://schema.org/Product
 * @param {object} product - Product document (lean)
 * @param {object} options
 * @param {string} [options.lang="he"]
 * @param {object|null} [options.reviewStats] - { avgRating, count }
 * @param {string} [options.categoryName]
 * @returns {object} Product JSON-LD
 */
export function buildProductJsonLd(product, options = {}) {
  const { lang = "he", reviewStats = null, categoryName = "" } = options;

  const title = t(product, "title", lang) || t(product, "title", "he");
  const description = t(product, "description", lang) || t(product, "description", "he");
  const imageUrl = getProductImageUrl(product);
  const url = buildCanonicalUrl(`product/${product.slug}`);

  // Determine if product is on sale
  const now = new Date();
  const isOnSale =
    product.salePrice != null &&
    Number(product.salePrice) < Number(product.price) &&
    (!product.saleStartAt || now >= new Date(product.saleStartAt)) &&
    (!product.saleEndAt || now <= new Date(product.saleEndAt));

  const currentPrice = isOnSale ? product.salePrice : product.price;

  // Determine availability
  const inStock = product.stock > 0 || product.allowBackorder;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: title,
    description: description || undefined,
    image: imageUrl,
    url: url,
    sku: product.sku || undefined,
    gtin: product.barcode || undefined,
    brand: product.brand
      ? {
          "@type": "Brand",
          name: product.brand,
        }
      : undefined,
    category: categoryName || undefined,
    offers: {
      "@type": "Offer",
      url: url,
      priceCurrency: "ILS",
      price: Number(currentPrice || 0).toFixed(2),
      availability: inStock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: {
        "@type": "Organization",
        name: getStoreName(lang),
      },
      priceValidUntil: isOnSale && product.saleEndAt
        ? new Date(product.saleEndAt).toISOString().split("T")[0]
        : undefined,
    },
  };

  // Add aggregate rating if reviews exist
  if (reviewStats && reviewStats.count > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Number(reviewStats.avgRating || 0).toFixed(1),
      reviewCount: reviewStats.count,
      bestRating: 5,
      worstRating: 1,
    };
  }

  // Clean undefined values recursively
  return cleanJsonLd(schema);
}

/**
 * Build BreadcrumbList JSON-LD
 * @param {Array<{name: string, path: string}>} breadcrumbs
 * @param {string} [lang="he"]
 * @returns {object|null} BreadcrumbList JSON-LD or null if empty
 */
export function buildBreadcrumbJsonLd(breadcrumbs, lang = "he") {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) {
    return null;
  }

  const storeName = getStoreName(lang);

  const items = [
    {
      "@type": "ListItem",
      position: 1,
      name: storeName,
      item: STORE_BASE_URL,
    },
    ...breadcrumbs.map((bc, idx) => ({
      "@type": "ListItem",
      position: idx + 2,
      name: bc.name,
      item: buildCanonicalUrl(bc.path),
    })),
  ];

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  };
}

/**
 * Build CollectionPage JSON-LD for category listings
 * @param {object} category - Category document (lean)
 * @param {object} options
 * @param {string} [options.lang="he"]
 * @param {number} [options.productCount=0]
 * @param {Array} [options.breadcrumbs=[]]
 * @returns {object|Array} CollectionPage JSON-LD or array with BreadcrumbList
 */
export function buildCategoryJsonLd(category, options = {}) {
  const { lang = "he", productCount = 0, breadcrumbs = [] } = options;

  const name = t(category, "name", lang) || t(category, "name", "he");
  const description = t(category, "seoDesc", lang) || t(category, "metaDescription", lang) || "";
  const imageUrl = getCategoryImageUrl(category);
  const url = buildCanonicalUrl(`category/${category.slug}`);

  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: name,
    description: description || undefined,
    url: url,
    image: imageUrl,
    numberOfItems: productCount,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: productCount,
    },
  };

  const cleanSchema = cleanJsonLd(schema);

  // Build breadcrumb if available
  const breadcrumbLd = buildBreadcrumbJsonLd(breadcrumbs, lang);

  if (breadcrumbLd) {
    return [cleanSchema, breadcrumbLd];
  }

  return cleanSchema;
}

/**
 * Build WebPage JSON-LD for content pages
 * @param {object} page - ContentPage document (lean)
 * @param {string} [lang="he"]
 * @returns {object} WebPage JSON-LD
 */
export function buildWebPageJsonLd(page, lang = "he") {
  const title = t(page, "title", lang) || t(page, "title", "he");
  const url = buildCanonicalUrl(`page/${page.slug}`);
  const storeName = getStoreName(lang);

  return cleanJsonLd({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url: url,
    inLanguage: lang === "ar" ? "ar" : "he",
    publisher: {
      "@type": "Organization",
      name: storeName,
      url: STORE_BASE_URL,
    },
    dateModified: page.updatedAt
      ? new Date(page.updatedAt).toISOString()
      : undefined,
  });
}

/**
 * Build Organization JSON-LD schema
 * @param {object} [siteSettings={}] - SiteSettings document (lean)
 * @param {string} [lang="he"]
 * @returns {object} Organization JSON-LD
 */
export function buildOrganizationJsonLd(siteSettings = {}, lang = "he") {
  const storeName =
    lang === "ar"
      ? siteSettings.storeNameAr || STORE_NAME_AR
      : siteSettings.storeNameHe || STORE_NAME_HE;

  const address =
    lang === "ar" ? siteSettings.addressAr : siteSettings.addressHe;

  // Collect social links
  const sameAs = [];
  if (siteSettings.socialLinks?.instagram)
    sameAs.push(siteSettings.socialLinks.instagram);
  if (siteSettings.socialLinks?.facebook)
    sameAs.push(siteSettings.socialLinks.facebook);
  if (siteSettings.socialLinks?.tiktok)
    sameAs.push(siteSettings.socialLinks.tiktok);

  // Build contact point
  const contactTel = siteSettings.phone || siteSettings.whatsappNumber;
  const contactEmail = siteSettings.email;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: storeName,
    url: STORE_BASE_URL,
    logo: siteSettings.logoUrl || STORE_OG_IMAGE_URL,
    contactPoint:
      contactTel || contactEmail
        ? {
            "@type": "ContactPoint",
            telephone: contactTel || undefined,
            email: contactEmail || undefined,
            contactType: "customer service",
            availableLanguage: ["Hebrew", "Arabic"],
          }
        : undefined,
    address: address
      ? {
          "@type": "PostalAddress",
          addressCountry: "IL",
          streetAddress: address,
        }
      : undefined,
    sameAs: sameAs.length > 0 ? sameAs : undefined,
  };

  return cleanJsonLd(schema);
}

/**
 * Build WebSite JSON-LD with search action (optional)
 * @param {object} [siteSettings={}]
 * @param {string} [lang="he"]
 * @returns {object} WebSite JSON-LD
 */
export function buildWebSiteJsonLd(siteSettings = {}, lang = "he") {
  const storeName =
    lang === "ar"
      ? siteSettings.storeNameAr || STORE_NAME_AR
      : siteSettings.storeNameHe || STORE_NAME_HE;

  return cleanJsonLd({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: storeName,
    url: STORE_BASE_URL,
    inLanguage: lang === "ar" ? "ar" : "he",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${STORE_BASE_URL}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  });
}

/**
 * Recursively clean undefined values from JSON-LD object
 * @param {object} obj
 * @returns {object}
 */
function cleanJsonLd(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    return obj.map(cleanJsonLd).filter((v) => v !== undefined);
  }
  if (typeof obj !== "object") return obj;

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    const cleanedValue = cleanJsonLd(value);
    if (cleanedValue !== undefined && cleanedValue !== "") {
      cleaned[key] = cleanedValue;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
