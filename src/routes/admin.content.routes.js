// src/routes/admin.content.routes.js
import express from "express";
import { z } from "zod";
import mongoose from "mongoose";

import { ContentPage } from "../models/ContentPage.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { auditAdmin } from "../middleware/audit.js";
import { validate } from "../middleware/validate.js";
import { t } from "../utils/i18n.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";
import { sanitizeRichText } from "../utils/sanitize.js";

const router = express.Router();

router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.SETTINGS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

const objectIdSchema = z
  .string()
  .min(1)
  .refine((v) => isValidObjectId(v), { message: "Invalid id" });

function makeErr(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function jsonRes(res, data, meta = null) {
  return sendOk(res, data, meta);
}

function jsonErr(res, e) {
  return sendError(
    res,
    e.statusCode || 500,
    e.code || "INTERNAL_ERROR",
    e.message || "Unexpected error"
  );
}

function safeNotFound(res, code = "NOT_FOUND", message = "Not found") {
  return sendError(res, 404, code, message);
}

function normalizeSlug(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  return v
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u0590-\u05ff\u0600-\u06ff-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * sanitize rich text fields before storing
 * Note: titles should be plain text; if you want to allow rich text in titles, change this.
 */
function sanitizeTitle(input) {
  // Titles should not contain HTML; strip anything suspicious
  return String(input || "").replace(/<[^>]*>/g, "").trim();
}

function mapPage(p, lang) {
  const obj = typeof p.toObject === "function" ? p.toObject() : { ...p };

  // Defense-in-depth: sanitize output too
  const titleHe = obj.titleHe || "";
  const titleAr = obj.titleAr || "";
  const contentHe = obj.contentHe || "";
  const contentAr = obj.contentAr || "";

  return {
    id: obj._id,
    _id: obj._id,

    slug: obj.slug || "",

    titleHe: titleHe,
    titleAr: titleAr,
    title: t(obj, "title", lang),

    contentHe: sanitizeRichText(contentHe),
    contentAr: sanitizeRichText(contentAr),
    content: sanitizeRichText(t(obj, "content", lang)),

    isActive: Boolean(obj.isActive),
    sortOrder: obj.sortOrder ?? 100,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

/* ============================
   Schemas
============================ */

const listQuerySchema = z.object({
  query: z
    .object({
      isActive: z.enum(["true", "false"]).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .optional(),
});

const createBodySchema = z
  .object({
    slug: z.string().min(2).max(80),

    titleHe: z.string().min(2).max(160),
    titleAr: z.string().max(160).optional(),

    contentHe: z.string().min(1).max(20000),
    contentAr: z.string().max(20000).optional(),

    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    slug: z.string().min(2).max(80).optional(),

    titleHe: z.string().min(2).max(160).optional(),
    titleAr: z.string().max(160).optional(),

    contentHe: z.string().min(1).max(20000).optional(),
    contentAr: z.string().max(20000).optional(),

    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

const publishSchema = z.object({
  params: z.object({ id: objectIdSchema }),
  body: z
    .object({
      isActive: z.boolean(),
    })
    .strict(),
});

const idParamSchema = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
});

/* ============================
   GET /api/admin/content/pages
============================ */

router.get("/pages", validate(listQuerySchema), async (req, res) => {
  try {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 50)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.isActive === "true") {
      filter.isActive = true;
    } else if (q.isActive === "false") {
      filter.isActive = false;
    }

    const [items, total] = await Promise.all([
      ContentPage.find(filter)
        .sort({ sortOrder: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ContentPage.countDocuments(filter),
    ]);

    const mapped = items.map((p) => mapPage(p, req.lang));

    return jsonRes(res, mapped, {
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
   GET /api/admin/content/pages/:id
============================ */

router.get("/pages/:id", validate(idParamSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id);

    const item = await ContentPage.findById(id).lean();
    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "Content page not found");
    }

    return jsonRes(res, mapPage(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   POST /api/admin/content/pages
============================ */

router.post("/pages", validate(z.object({ body: createBodySchema })), async (req, res) => {
  try {
    const b = req.validated.body;

    const slug = normalizeSlug(b.slug);
    if (!slug) {
      throw makeErr(400, "INVALID_SLUG", "Invalid slug format");
    }

    // Check slug uniqueness
    const existing = await ContentPage.findOne({ slug }).select("_id").lean();
    if (existing) {
      throw makeErr(409, "SLUG_EXISTS", `Slug "${slug}" already exists`);
    }

    // ✅ XSS protection: sanitize rich text before storing
    const safeTitleHe = sanitizeTitle(b.titleHe);
    const safeTitleAr = sanitizeTitle(b.titleAr || "");

    const safeContentHe = sanitizeRichText(b.contentHe);
    const safeContentAr = sanitizeRichText(b.contentAr || "");

    const item = await ContentPage.create({
      slug,

      titleHe: safeTitleHe,
      titleAr: safeTitleAr,

      contentHe: safeContentHe,
      contentAr: safeContentAr,

      isActive: b.isActive ?? false,
      sortOrder: b.sortOrder ?? 100,
    });

    return sendCreated(res, mapPage(item, req.lang));
  } catch (e) {
    // Handle MongoDB duplicate key error
    if (e?.code === 11000 || e?.code === "SLUG_EXISTS") {
      return sendError(res, 409, "SLUG_EXISTS", "Slug already exists");
    }
    return jsonErr(res, e);
  }
});

/* ============================
   PUT /api/admin/content/pages/:id
============================ */

router.put(
  "/pages/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }), body: updateBodySchema })),
  async (req, res) => {
    try {
      const id = String(req.validated.params.id);

      const existing = await ContentPage.findById(id).select("_id slug").lean();
      if (!existing) {
        return safeNotFound(res, "NOT_FOUND", "Content page not found");
      }

      const b = req.validated.body;
      const update = {};

      if (b.slug !== undefined) {
        const slug = normalizeSlug(b.slug);
        if (!slug) {
          throw makeErr(400, "INVALID_SLUG", "Invalid slug format");
        }

        // Check slug uniqueness (excluding current document)
        const duplicate = await ContentPage.findOne({ slug, _id: { $ne: id } })
          .select("_id")
          .lean();

        if (duplicate) {
          throw makeErr(409, "SLUG_EXISTS", `Slug "${slug}" already exists`);
        }

        update.slug = slug;
      }

      // Titles should be plain text
      if (b.titleHe !== undefined) update.titleHe = sanitizeTitle(b.titleHe);
      if (b.titleAr !== undefined) update.titleAr = sanitizeTitle(b.titleAr);

      // ✅ XSS protection: sanitize before storing
      if (b.contentHe !== undefined) update.contentHe = sanitizeRichText(b.contentHe);
      if (b.contentAr !== undefined) update.contentAr = sanitizeRichText(b.contentAr);

      if (b.isActive !== undefined) update.isActive = b.isActive;
      if (b.sortOrder !== undefined) update.sortOrder = b.sortOrder;

      const item = await ContentPage.findByIdAndUpdate(id, update, {
        new: true,
        runValidators: true,
      });

      if (!item) {
        return safeNotFound(res, "NOT_FOUND", "Content page not found");
      }

      return jsonRes(res, mapPage(item, req.lang));
    } catch (e) {
      if (e?.code === 11000 || e?.code === "SLUG_EXISTS") {
        return sendError(res, 409, "SLUG_EXISTS", "Slug already exists");
      }
      return jsonErr(res, e);
    }
  }
);

/* ============================
   PATCH /api/admin/content/pages/:id/publish
============================ */

router.patch("/pages/:id/publish", validate(publishSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id);
    const { isActive } = req.validated.body;

    const item = await ContentPage.findByIdAndUpdate(
      id,
      { $set: { isActive } },
      { new: true, runValidators: true }
    );

    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "Content page not found");
    }

    return jsonRes(res, mapPage(item, req.lang));
  } catch (e) {
    return jsonErr(res, e);
  }
});

/* ============================
   DELETE /api/admin/content/pages/:id
============================ */

router.delete("/pages/:id", validate(idParamSchema), async (req, res) => {
  try {
    const id = String(req.validated.params.id);

    const item = await ContentPage.findByIdAndDelete(id);
    if (!item) {
      return safeNotFound(res, "NOT_FOUND", "Content page not found");
    }

    return sendOk(res, { deleted: true, id: item._id });
  } catch (e) {
    return jsonErr(res, e);
  }
});

export default router;
