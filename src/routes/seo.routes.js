// src/routes/seo.routes.js
// SEO metadata API endpoints for SSR/frontend consumption.

import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { ContentPage } from "../models/ContentPage.js";
import { Review } from "../models/Review.js";
import { SiteSettings } from "../models/SiteSettings.js";

import { validate } from "../middleware/validate.js";
import { sendOk, sendError } from "../utils/response.js";
import { t, pickLang } from "../utils/i18n.js";
import {
  buildCanonicalUrl,
  buildAlternates,
  buildOgMeta,
  buildTwitterMeta,
  truncateSeoText,
  getProductImageUrl,
  getCategoryImageUrl,
  STORE_OG_IMAGE_URL,
} from "../utils/seo.js";
import {
  buildProductJsonLd,
  buildCategoryJsonLd,
  buildBreadcrumbJsonLd,
  buildWebPageJsonLd,
  buildOrganizationJsonLd,
} from "../utils/jsonld.js";

const router = express.Router();

/**
 * Set cache headers for SEO endpoints
 * @param {object} res - Express response
 * @param {number} [maxAge=60] - max-age in seconds
 * @param {number} [staleWhileRevalidate=300] - stale-while-revalidate in seconds
 */
function setCacheHeaders(res, maxAge = 60, staleWhileRevalidate = 300) {
  res.set(
    "Cache-Control",
    `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
}

/**
 * Check if string is a valid MongoDB ObjectId
 * @param {string} id
 * @returns {boolean}
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

// ============================================================
// Validation Schemas
// ============================================================

const slugParamSchema = z.object({
  params: z.object({
    slug: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9-]+$/i, "Invalid slug format"),
  }),
});

const pageKeyParamSchema = z.object({
  params: z.object({
    pageKey: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/i, "Invalid page key format"),
  }),
});

const listingQuerySchema = z.object({
  query: z
    .object({
      page: z.string().optional(),
      limit: z.string().optional(),
      categorySlug: z.string().max(160).optional(),
      path: z.string().max(200).optional(),
    })
    .optional(),
});

// ============================================================
// Product SEO Meta
// ============================================================

/**
 * GET /api/v1/seo/meta/product/:slug
 * Returns SEO metadata for a product page
 */
router.get("/meta/product/:slug", validate(slugParamSchema), async (req, res) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const lang = pickLang(req.lang);

    // Find product with minimal projection
    const product = await Product.findOne({
      slug,
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select(
        "titleHe titleAr descriptionHe descriptionAr " +
          "metaTitleHe metaTitleAr metaDescriptionHe metaDescriptionAr " +
          "slug price salePrice saleStartAt saleEndAt stock allowBackorder " +
          "brand sku barcode images imageUrl categoryId"
      )
      .lean();

    if (!product) {
      return sendError(res, 404, "NOT_FOUND", "Product not found");
    }

    // Fetch category for breadcrumb and JSON-LD
    let category = null;
    let categoryName = "";
    if (product.categoryId && isValidObjectId(product.categoryId)) {
      category = await Category.findById(product.categoryId)
        .select("nameHe nameAr slug")
        .lean();
      if (category) {
        categoryName = t(category, "name", lang);
      }
    }

    // Fetch review stats for aggregate rating
    const reviewStats = await Review.aggregate([
      {
        $match: {
          productId: product._id,
          isHidden: { $ne: true },
          $or: [
            { moderationStatus: "approved" },
            { moderationStatus: { $exists: false } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          avgRating: { $avg: "$rating" },
          count: { $sum: 1 },
        },
      },
    ]);

    const stats = reviewStats[0] || { avgRating: 0, count: 0 };

    // Build SEO metadata
    const title = t(product, "metaTitle", lang) || t(product, "title", lang);
    const description = truncateSeoText(
      t(product, "metaDescription", lang) || t(product, "description", lang),
      160
    );
    const imageUrl = getProductImageUrl(product);
    const canonicalUrl = buildCanonicalUrl(`product/${product.slug}`);
    const alternates = buildAlternates(`product/${product.slug}`);

    // Build breadcrumbs
    const breadcrumbs = [];
    if (category) {
      breadcrumbs.push({
        name: categoryName,
        path: `category/${category.slug}`,
      });
    }
    breadcrumbs.push({
      name: t(product, "title", lang),
      path: `product/${product.slug}`,
    });

    // Build JSON-LD
    const jsonLd = buildProductJsonLd(product, {
      lang,
      reviewStats: { avgRating: stats.avgRating, count: stats.count },
      categoryName,
    });

    const breadcrumbLd = buildBreadcrumbJsonLd(breadcrumbs, lang);

    setCacheHeaders(res, 60, 300);

    return sendOk(res, {
      type: "product",
      canonicalUrl,
      lang,
      title,
      description,
      og: buildOgMeta({
        title,
        description,
        image: imageUrl,
        url: canonicalUrl,
        type: "product",
        lang,
      }),
      twitter: buildTwitterMeta({ title, description, image: imageUrl }),
      alternates,
      jsonLd: breadcrumbLd ? [jsonLd, breadcrumbLd] : jsonLd,
    });
  } catch (e) {
    console.error("[seo] meta/product error:", e);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch product SEO metadata");
  }
});

// ============================================================
// Category SEO Meta
// ============================================================

/**
 * GET /api/v1/seo/meta/category/:slug
 * Returns SEO metadata for a category page
 */
router.get("/meta/category/:slug", validate(slugParamSchema), async (req, res) => {
  try {
    const slug = String(req.params.slug).toLowerCase();
    const lang = pickLang(req.lang);

    // Find category with minimal projection
    const category = await Category.findOne({ slug, isActive: true })
      .select(
        "nameHe nameAr seoTitleHe seoTitleAr seoDescHe seoDescAr " +
          "metaTitleHe metaTitleAr metaDescriptionHe metaDescriptionAr " +
          "slug imageUrl bannerUrl parentId"
      )
      .lean();

    if (!category) {
      return sendError(res, 404, "NOT_FOUND", "Category not found");
    }

    // Count products in category
    const productCount = await Product.countDocuments({
      categoryId: category._id,
      isActive: true,
      isDeleted: { $ne: true },
    });

    // Build breadcrumbs (including parent if exists)
    const breadcrumbs = [];
    if (category.parentId && isValidObjectId(category.parentId)) {
      const parent = await Category.findById(category.parentId)
        .select("nameHe nameAr slug")
        .lean();
      if (parent) {
        breadcrumbs.push({
          name: t(parent, "name", lang),
          path: `category/${parent.slug}`,
        });
      }
    }
    breadcrumbs.push({
      name: t(category, "name", lang),
      path: `category/${category.slug}`,
    });

    // Build SEO metadata
    const name = t(category, "name", lang);
    const title = t(category, "seoTitle", lang) || t(category, "metaTitle", lang) || name;
    const description = truncateSeoText(
      t(category, "seoDesc", lang) || t(category, "metaDescription", lang) || "",
      160
    );
    const imageUrl = getCategoryImageUrl(category);
    const canonicalUrl = buildCanonicalUrl(`category/${category.slug}`);
    const alternates = buildAlternates(`category/${category.slug}`);

    // Build JSON-LD
    const jsonLd = buildCategoryJsonLd(category, {
      lang,
      productCount,
      breadcrumbs,
    });

    setCacheHeaders(res, 60, 300);

    return sendOk(res, {
      type: "category",
      canonicalUrl,
      lang,
      title,
      description,
      og: buildOgMeta({
        title,
        description,
        image: imageUrl,
        url: canonicalUrl,
        type: "website",
        lang,
      }),
      twitter: buildTwitterMeta({ title, description, image: imageUrl }),
      alternates,
      jsonLd,
      productCount,
    });
  } catch (e) {
    console.error("[seo] meta/category error:", e);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch category SEO metadata");
  }
});

// ============================================================
// Content Page SEO Meta
// ============================================================

/**
 * GET /api/v1/seo/meta/page/:pageKey
 * Returns SEO metadata for a content page (about, terms, privacy, etc.)
 */
router.get("/meta/page/:pageKey", validate(pageKeyParamSchema), async (req, res) => {
  try {
    const pageKey = String(req.params.pageKey).toLowerCase();
    const lang = pickLang(req.lang);

    // Find content page
    const page = await ContentPage.findOne({ slug: pageKey, isActive: true })
      .select("titleHe titleAr slug updatedAt")
      .lean();

    if (!page) {
      return sendError(res, 404, "NOT_FOUND", "Content page not found");
    }

    const title = t(page, "title", lang);
    const canonicalUrl = buildCanonicalUrl(`page/${page.slug}`);
    const alternates = buildAlternates(`page/${page.slug}`);

    // Build JSON-LD
    const jsonLd = buildWebPageJsonLd(page, lang);

    setCacheHeaders(res, 60, 300);

    return sendOk(res, {
      type: "page",
      canonicalUrl,
      lang,
      title,
      description: "",
      og: buildOgMeta({
        title,
        description: "",
        image: STORE_OG_IMAGE_URL,
        url: canonicalUrl,
        type: "website",
        lang,
      }),
      twitter: buildTwitterMeta({
        title,
        description: "",
        image: STORE_OG_IMAGE_URL,
      }),
      alternates,
      jsonLd,
    });
  } catch (e) {
    console.error("[seo] meta/page error:", e);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch page SEO metadata");
  }
});

// ============================================================
// Listing Pagination SEO Meta
// ============================================================

/**
 * GET /api/v1/seo/meta/listing
 * Returns SEO metadata for paginated listings with rel prev/next
 */
router.get("/meta/listing", validate(listingQuerySchema), async (req, res) => {
  try {
    const lang = pickLang(req.lang);
    const page = Math.max(Number(req.query?.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query?.limit || 12), 1), 50);
    const categorySlug = String(req.query?.categorySlug || "").toLowerCase();
    const basePath = String(req.query?.path || "products").replace(/^\/+/, "");

    // Determine total count and metadata
    let total = 0;
    let title = lang === "ar" ? "المنتجات" : "מוצרים";
    let description = "";

    if (categorySlug) {
      const category = await Category.findOne({
        slug: categorySlug,
        isActive: true,
      })
        .select(
          "_id nameHe nameAr seoTitleHe seoTitleAr seoDescHe seoDescAr metaTitleHe metaTitleAr metaDescriptionHe metaDescriptionAr"
        )
        .lean();

      if (category) {
        total = await Product.countDocuments({
          categoryId: category._id,
          isActive: true,
          isDeleted: { $ne: true },
        });
        title =
          t(category, "seoTitle", lang) ||
          t(category, "metaTitle", lang) ||
          t(category, "name", lang);
        description = t(category, "seoDesc", lang) || t(category, "metaDescription", lang) || "";
      }
    } else {
      total = await Product.countDocuments({
        isActive: true,
        isDeleted: { $ne: true },
      });
    }

    const totalPages = Math.ceil(total / limit);

    // Build pagination URLs
    const buildPageUrl = (p) => {
      const params = new URLSearchParams();
      if (p > 1) params.set("page", String(p));
      if (limit !== 12) params.set("limit", String(limit));
      if (categorySlug) params.set("categorySlug", categorySlug);
      const qs = params.toString();
      return buildCanonicalUrl(basePath + (qs ? `?${qs}` : ""));
    };

    const canonicalUrl = buildPageUrl(page);
    const relPrev = page > 1 ? buildPageUrl(page - 1) : null;
    const relNext = page < totalPages ? buildPageUrl(page + 1) : null;

    // Append page number to title if not first page
    const pageTitle =
      page > 1
        ? `${title} - ${lang === "ar" ? "صفحة" : "עמוד"} ${page}`
        : title;

    setCacheHeaders(res, 60, 300);

    return sendOk(res, {
      type: "listing",
      canonicalUrl,
      lang,
      title: pageTitle,
      description,
      og: buildOgMeta({
        title: pageTitle,
        description,
        image: STORE_OG_IMAGE_URL,
        url: canonicalUrl,
        type: "website",
        lang,
      }),
      twitter: buildTwitterMeta({
        title: pageTitle,
        description,
        image: STORE_OG_IMAGE_URL,
      }),
      alternates: buildAlternates(basePath),
      pagination: {
        relPrev,
        relNext,
        currentPage: page,
        totalPages,
        total,
      },
    });
  } catch (e) {
    console.error("[seo] meta/listing error:", e);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch listing SEO metadata");
  }
});

// ============================================================
// Organization Schema
// ============================================================

/**
 * GET /api/v1/seo/schema/organization
 * Returns Organization JSON-LD schema
 */
router.get("/schema/organization", async (req, res) => {
  try {
    const lang = pickLang(req.lang);

    // Get site settings (singleton pattern)
    const settings = await SiteSettings.findOne().lean();

    const jsonLd = buildOrganizationJsonLd(settings || {}, lang);

    setCacheHeaders(res, 300, 600);

    return sendOk(res, { jsonLd });
  } catch (e) {
    console.error("[seo] schema/organization error:", e);
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch organization schema");
  }
});

export default router;
