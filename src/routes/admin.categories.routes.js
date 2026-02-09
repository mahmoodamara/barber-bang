// src/routes/admin.categories.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { t } from "../utils/i18n.js";
import { invalidateHomeCache, invalidateCategoriesCache } from "../utils/cache.js";

const router = express.Router();

function invalidateCategoryCaches() {
  invalidateHomeCache().catch(() => {});
  invalidateCategoriesCache().catch(() => {});
}

router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.PRODUCTS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function makeSearchRegex(raw, max = 120) {
  const search = String(raw || "").trim().slice(0, max);
  if (!search) return null;
  return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/**
 * Sanitize admin notes / rich text to prevent XSS
 * Strips HTML tags and limits length
 */
function sanitizeText(input, maxLen = 500) {
  if (typeof input !== "string") return "";
  return input
    .replace(/<[^>]*>/g, "") // Strip HTML tags
    .trim()
    .slice(0, maxLen);
}

/**
 * Map category for response with localized name.
 * Ensures slug is never "" so frontend Select.Item (Radix) never receives value="" .
 */
function mapCategory(cat, lang = "he") {
  if (!cat) return null;
  const obj = cat.toObject ? cat.toObject() : cat;
  const slug = (obj.slug && String(obj.slug).trim()) ? obj.slug : (obj._id ? String(obj._id) : "__pending__");
  return {
    ...obj,
    slug,
    name: t(obj, "name", lang),
  };
}

/* ============================
   Schemas
============================ */

const objectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid id" });

const listQuerySchema = z.object({
  query: z
    .object({
      q: z.string().max(120).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
      sortBy: z.enum(["createdAt", "updatedAt", "nameHe", "nameAr", "slug", "sortOrder"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
      lang: z.string().optional(),
    })
    .strict()
    .optional(),
});

const createSchema = z.object({
  body: z
    .object({
      nameHe: z.string().min(2).max(80),
      nameAr: z.string().max(80).optional(),
      slug: z.string().max(60).optional(),
      imageUrl: z.string().max(500).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      parentId: objectIdSchema.optional(),
      // Model fields (metaTitle*/metaDescription*)
      metaTitleHe: z.string().max(70).optional(),
      metaTitleAr: z.string().max(70).optional(),
      metaDescriptionHe: z.string().max(160).optional(),
      metaDescriptionAr: z.string().max(160).optional(),
      // Aliases for backward compatibility (map to meta* when saving)
      seoTitleHe: z.string().max(70).optional(),
      seoTitleAr: z.string().max(70).optional(),
      seoDescHe: z.string().max(160).optional(),
      seoDescAr: z.string().max(160).optional(),
    })
    .strict(),
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      nameHe: z.string().min(2).max(80).optional(),
      nameAr: z.string().max(80).optional(),
      slug: z.string().max(60).optional(),
      imageUrl: z.string().max(500).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      parentId: objectIdSchema.optional().nullable(),
      metaTitleHe: z.string().max(70).optional(),
      metaTitleAr: z.string().max(70).optional(),
      metaDescriptionHe: z.string().max(160).optional(),
      metaDescriptionAr: z.string().max(160).optional(),
      seoTitleHe: z.string().max(70).optional(),
      seoTitleAr: z.string().max(70).optional(),
      seoDescHe: z.string().max(160).optional(),
      seoDescAr: z.string().max(160).optional(),
    })
    .strict(),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
});

/* ============================
   GET /api/v1/admin/categories
   List with pagination, search, sort
============================ */

router.get("/", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};
    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 20)));
    const skip = (page - 1) * limit;

    const filter = {};
    const regex = makeSearchRegex(q.q);
    if (regex) {
      filter.$or = [{ nameHe: regex }, { nameAr: regex }, { name: regex }, { slug: regex }];
    }

    // Safe sorting with allowlist - sortBy already validated by Zod
    let sortOption = { createdAt: -1 };
    if (q.sortBy) {
      const dir = q.sortDir === "asc" ? 1 : -1;
      sortOption = { [q.sortBy]: dir };
    }

    const [items, total] = await Promise.all([
      Category.find(filter).sort(sortOption).skip(skip).limit(limit).lean(),
      Category.countDocuments(filter),
    ]);

    const mapped = items.map((c) => mapCategory(c, req.lang));

    return sendOk(res, mapped, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   GET /api/v1/admin/categories/:id
   Get single category
============================ */

router.get("/:id", validate(idParamSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      throw makeErr(400, "INVALID_ID", "Invalid category id");
    }

    const item = await Category.findById(id).lean();
    if (!item) {
      throw makeErr(404, "NOT_FOUND", "Category not found");
    }

    return sendOk(res, mapCategory(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/v1/admin/categories
   Create new category
============================ */

router.post("/", validate(createSchema), async (req, res) => {
  try {
    const b = req.validated.body;
    const {
      nameHe,
      nameAr,
      slug,
      imageUrl,
      isActive,
      sortOrder,
      parentId,
    } = b;

    // Sanitize inputs
    const sanitizedNameHe = sanitizeText(nameHe, 80);
    const sanitizedNameAr = sanitizeText(nameAr || "", 80);
    const sanitizedSlug = sanitizeText(slug || "", 60).toLowerCase().replace(/\s+/g, "-");
    const sanitizedImageUrl = sanitizeText(imageUrl || "", 500);

    // Map to model fields: metaTitle* / metaDescription* (accept seo* aliases)
    const metaTitleHe = sanitizeText(b.metaTitleHe ?? b.seoTitleHe ?? "", 70);
    const metaTitleAr = sanitizeText(b.metaTitleAr ?? b.seoTitleAr ?? "", 70);
    const metaDescriptionHe = sanitizeText(b.metaDescriptionHe ?? b.seoDescHe ?? "", 160);
    const metaDescriptionAr = sanitizeText(b.metaDescriptionAr ?? b.seoDescAr ?? "", 160);

    const item = await Category.create({
      nameHe: sanitizedNameHe,
      nameAr: sanitizedNameAr,
      name: sanitizedNameHe, // Legacy field
      slug: sanitizedSlug,
      imageUrl: sanitizedImageUrl,
      isActive: isActive ?? true,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      parentId: parentId || null,
      metaTitleHe,
      metaTitleAr,
      metaDescriptionHe,
      metaDescriptionAr,
    });

    invalidateCategoryCaches();
    return sendCreated(res, mapCategory(item, req.lang));
  } catch (e) {
    // Handle duplicate key error
    if (e.code === 11000) {
      return sendError(res, 409, "DUPLICATE_KEY", "Category with this name or slug already exists");
    }
    return jsonErr(res, e);
  }
});

/* ============================
   PUT /api/v1/admin/categories/:id
   Update category
============================ */

router.put("/:id", validate(updateSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      throw makeErr(400, "INVALID_ID", "Invalid category id");
    }

    const b = req.validated.body;
    const {
      nameHe,
      nameAr,
      slug,
      imageUrl,
      isActive,
      sortOrder,
      parentId,
    } = b;

    // Build update object with sanitized values
    const update = {};
    if (nameHe !== undefined) {
      update.nameHe = sanitizeText(nameHe, 80);
      update.name = update.nameHe; // Keep legacy field in sync
    }
    if (nameAr !== undefined) {
      update.nameAr = sanitizeText(nameAr, 80);
    }
    if (slug !== undefined) {
      update.slug = sanitizeText(slug, 60).toLowerCase().replace(/\s+/g, "-");
    }
    if (imageUrl !== undefined) {
      update.imageUrl = sanitizeText(imageUrl, 500);
    }
    if (isActive !== undefined) {
      update.isActive = Boolean(isActive);
    }
    if (sortOrder !== undefined && Number.isFinite(sortOrder)) {
      update.sortOrder = Math.trunc(sortOrder);
    }
    if (parentId !== undefined) {
      update.parentId = parentId || null;
    }
    // Map to model fields: metaTitle* / metaDescription* (accept seo* aliases)
    if (b.metaTitleHe !== undefined || b.seoTitleHe !== undefined) {
      update.metaTitleHe = sanitizeText(b.metaTitleHe ?? b.seoTitleHe ?? "", 70);
    }
    if (b.metaTitleAr !== undefined || b.seoTitleAr !== undefined) {
      update.metaTitleAr = sanitizeText(b.metaTitleAr ?? b.seoTitleAr ?? "", 70);
    }
    if (b.metaDescriptionHe !== undefined || b.seoDescHe !== undefined) {
      update.metaDescriptionHe = sanitizeText(b.metaDescriptionHe ?? b.seoDescHe ?? "", 160);
    }
    if (b.metaDescriptionAr !== undefined || b.seoDescAr !== undefined) {
      update.metaDescriptionAr = sanitizeText(b.metaDescriptionAr ?? b.seoDescAr ?? "", 160);
    }

    if (Object.keys(update).length === 0) {
      throw makeErr(400, "VALIDATION_ERROR", "No valid fields to update");
    }

    const item = await Category.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
    if (!item) {
      throw makeErr(404, "NOT_FOUND", "Category not found");
    }

    invalidateCategoryCaches();
    return sendOk(res, mapCategory(item, req.lang));
  } catch (e) {
    // Handle duplicate key error
    if (e.code === 11000) {
      return sendError(res, 409, "DUPLICATE_KEY", "Category with this name or slug already exists");
    }
    return jsonErr(res, e);
  }
});

/* ============================
   DELETE /api/v1/admin/categories/:id
   Delete category
============================ */

router.delete("/:id", validate(idParamSchema), async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!isValidObjectId(id)) {
      throw makeErr(400, "INVALID_ID", "Invalid category id");
    }

    // Check if category exists
    const category = await Category.findById(id);
    if (!category) {
      throw makeErr(404, "NOT_FOUND", "Category not found");
    }

    // Check for product references (including soft-deleted products)
    const productCount = await Product.countDocuments({ categoryId: id });
    if (productCount > 0) {
      throw makeErr(
        409,
        "CATEGORY_HAS_PRODUCTS",
        `Cannot delete category: ${productCount} product(s) are still referencing this category`
      );
    }

    // Check for child categories
    const childCount = await Category.countDocuments({ parentId: id });
    if (childCount > 0) {
      throw makeErr(
        409,
        "CATEGORY_HAS_CHILDREN",
        `Cannot delete category: ${childCount} child category/categories still exist`
      );
    }

    await Category.deleteOne({ _id: id });

    invalidateCategoryCaches();
    return sendOk(res, { deleted: true, id: category._id });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
