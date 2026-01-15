// src/controllers/catalogV2.controller.js
// Additional controllers for frontend guide compatibility

import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { applyQueryBudget } from "../utils/queryBudget.js";
import { getLang, localizeCategory } from "../utils/lang.js";

/**
 * GET /api/v1/categories/:slug
 * Alias endpoint: Get category by slug (including fullSlug support)
 */
export async function getCategoryBySlug(req, res) {
  const lang = getLang(req);
  const slug = String(req.params.slug || "").trim();

  if (!slug) {
    const err = new Error("CATEGORY_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  // Try to find by slug first, then by fullSlug
  let cat = await applyQueryBudget(
    Category.findOne({
      slug,
      isActive: true,
      isDeleted: { $ne: true },
    }).lean()
  );

  // If not found by slug, try fullSlug
  if (!cat) {
    cat = await applyQueryBudget(
      Category.findOne({
        fullSlug: slug,
        isActive: true,
        isDeleted: { $ne: true },
      }).lean()
    );
  }

  if (!cat) {
    const err = new Error("CATEGORY_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  // Count products in this category and descendants
  const descendantCatsQuery = Category.find(
    { ancestors: cat._id, isDeleted: { $ne: true } },
    { _id: 1 }
  ).lean();
  const descendants = await applyQueryBudget(descendantCatsQuery);
  const catIds = [cat._id, ...descendants.map((d) => d._id)];

  const productsCount = await applyQueryBudget(
    Product.countDocuments({
      categoryIds: { $in: catIds },
      isActive: true,
      isDeleted: { $ne: true },
    })
  );

  const localized = localizeCategory(
    {
      id: String(cat._id),
      nameHe: cat.nameHe,
      nameAr: cat.nameAr,
      slug: cat.slug,
      fullSlug: cat.fullSlug,
      parentId: cat.parentId ? String(cat.parentId) : null,
      ancestors: (cat.ancestors || []).map((a) => String(a)),
      level: cat.level,
      sortOrder: cat.sortOrder,
      isActive: cat.isActive,
    },
    lang
  );

  res.json({
    ok: true,
    lang,
    category: {
      ...localized,
      image: cat.image || null,
      productsCount,
    },
  });
}

/**
 * GET /api/v1/brands/:slug
 * Alias endpoint: Get brand info by slug
 * Since brands are stored as strings in products, we return brand info from product aggregation
 */
export async function getBrandBySlug(req, res) {
  const lang = getLang(req);
  const slug = String(req.params.slug || "").trim();

  if (!slug) {
    const err = new Error("BRAND_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  // Find products with this brand (case-insensitive)
  const brandRegex = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

  const products = await applyQueryBudget(
    Product.find({
      brand: brandRegex,
      isActive: true,
      isDeleted: { $ne: true },
    })
      .select("brand")
      .limit(1)
      .lean()
  );

  if (!products.length) {
    const err = new Error("BRAND_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const brandName = products[0].brand;

  // Count products for this brand
  const productsCount = await applyQueryBudget(
    Product.countDocuments({
      brand: brandName,
      isActive: true,
      isDeleted: { $ne: true },
    })
  );

  res.json({
    ok: true,
    lang,
    brand: {
      name: brandName,
      slug: brandName.toLowerCase().replace(/\s+/g, "-"),
      productsCount,
    },
  });
}
