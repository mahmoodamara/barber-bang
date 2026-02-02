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

/* ============================
   Guards
============================ */

router.use(requireAuth());
router.use(requirePermission(PERMISSIONS.SETTINGS_WRITE));
router.use(auditAdmin());

/* ============================
   Helpers
============================ */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

function makeErr(statusCode, code, message, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

function jsonErr(res, e) {
  // Duplicate key: prefer consistent 409
  if (e?.code === 11000) {
    return sendError(res, 409, "SLUG_EXISTS", "Slug already exists");
  }

  return sendError(
    res,
    e?.statusCode || 500,
    e?.code || "INTERNAL_ERROR",
    e?.message || "Unexpected error",
    e?.details ? { details: e.details } : undefined
  );
}

function safeNotFound(res, message = "Content page not found") {
  return sendError(res, 404, "NOT_FOUND", message);
}

const asyncHandler =
  (fn) =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      return jsonErr(res, e);
    }
  };

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Titles should be plain text; remove HTML tags and hard-cap
function sanitizeTitle(input, max = 160) {
  const v = String(input || "").replace(/<[^>]*>/g, "").trim();
  return v.length > max ? v.slice(0, max) : v;
}

// Sanitize rich text before storing (and keep a hard cap)
function sanitizeContent(input, max = 20000) {
  const raw = String(input || "");
  const capped = raw.length > max ? raw.slice(0, max) : raw;
  return sanitizeRichText(capped);
}

function mapPage(p, lang) {
  const obj = typeof p?.toObject === "function" ? p.toObject() : { ...p };

  const titleHe = String(obj.titleHe || "");
  const titleAr = String(obj.titleAr || "");
  const contentHe = String(obj.contentHe || "");
  const contentAr = String(obj.contentAr || "");

  // Defense-in-depth: sanitize output too (in case legacy data contains unsafe HTML)
  return {
    id: obj._id,
    _id: obj._id, // legacy

    slug: String(obj.slug || ""),

    titleHe,
    titleAr,
    title: String(t(obj, "title", lang) || ""),

    contentHe: sanitizeRichText(contentHe),
    contentAr: sanitizeRichText(contentAr),
    content: sanitizeRichText(String(t(obj, "content", lang) || "")),

    isActive: Boolean(obj.isActive),
    sortOrder: obj.sortOrder ?? 100,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
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
      isActive: z.enum(["true", "false"]).optional(),
      // Optional search (not in original, but safe & useful)
      q: z.string().max(120).optional(),
      page: z.string().regex(/^\d+$/).optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
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
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
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
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .strict();

const publishSchema = z.object({
  params: z.object({ id: objectIdSchema }).strict(),
  body: z
    .object({
      isActive: z.boolean(),
    })
    .strict(),
});

const idParamSchema = z.object({
  params: z.object({ id: objectIdSchema }).strict(),
});

/* ============================
   Routes
============================ */

/**
 * GET /api/admin/content/pages
 * List content pages (with pagination, optional isActive and optional q search)
 */
router.get(
  "/pages",
  validate(listQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.validated.query || {};

    const page = Math.max(1, Number(q.page || 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit || 50)));
    const skip = (page - 1) * limit;

    const filter = {};

    if (q.isActive === "true") filter.isActive = true;
    else if (q.isActive === "false") filter.isActive = false;

    // Optional search by slug/title (safe regex)
    if (q.q) {
      const search = String(q.q).trim().slice(0, 120);
      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ slug: regex }, { titleHe: regex }, { titleAr: regex }];
      }
    }

    const [items, total] = await Promise.all([
      ContentPage.find(filter)
        .sort({ sortOrder: 1, createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ContentPage.countDocuments(filter),
    ]);

    return sendOk(
      res,
      items.map((p) => mapPage(p, req.lang)),
      { page, limit, total, pages: Math.ceil(total / limit) }
    );
  })
);

/**
 * GET /api/admin/content/pages/:id
 */
router.get(
  "/pages/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const id = String(req.validated.params.id);

    const item = await ContentPage.findById(toObjectId(id)).lean();
    if (!item) return safeNotFound(res);

    return sendOk(res, mapPage(item, req.lang));
  })
);

/**
 * POST /api/admin/content/pages
 */
router.post(
  "/pages",
  validate(z.object({ body: createBodySchema }).strict()),
  asyncHandler(async (req, res) => {
    const b = req.validated.body;

    const slug = normalizeSlug(b.slug);
    if (!slug) throw makeErr(400, "INVALID_SLUG", "Invalid slug format");

    // Let the DB unique index be the source of truth, but keep a nice early check for UX
    const existing = await ContentPage.findOne({ slug }).select("_id").lean();
    if (existing) throw makeErr(409, "SLUG_EXISTS", "Slug already exists");

    const doc = await ContentPage.create({
      slug,

      titleHe: sanitizeTitle(b.titleHe, 160),
      titleAr: sanitizeTitle(b.titleAr || "", 160),

      contentHe: sanitizeContent(b.contentHe, 20000),
      contentAr: sanitizeContent(b.contentAr || "", 20000),

      isActive: b.isActive ?? false,
      sortOrder: b.sortOrder ?? 100,
    });

    // Map + sanitize output for safety
    return sendCreated(res, mapPage(doc, req.lang));
  })
);

/**
 * PUT /api/admin/content/pages/:id
 * Partial update (PATCH-like) with strict allowlist
 */
router.put(
  "/pages/:id",
  validate(z.object({ params: z.object({ id: objectIdSchema }).strict(), body: updateBodySchema }).strict()),
  asyncHandler(async (req, res) => {
    const id = String(req.validated.params.id);
    const oid = toObjectId(id);

    const exists = await ContentPage.findById(oid).select("_id slug").lean();
    if (!exists) return safeNotFound(res);

    const b = req.validated.body;
    const update = {};

    if (b.slug !== undefined) {
      const slug = normalizeSlug(b.slug);
      if (!slug) throw makeErr(400, "INVALID_SLUG", "Invalid slug format");

      const dup = await ContentPage.findOne({ slug, _id: { $ne: oid } }).select("_id").lean();
      if (dup) throw makeErr(409, "SLUG_EXISTS", "Slug already exists");

      update.slug = slug;
    }

    if (b.titleHe !== undefined) update.titleHe = sanitizeTitle(b.titleHe, 160);
    if (b.titleAr !== undefined) update.titleAr = sanitizeTitle(b.titleAr, 160);

    if (b.contentHe !== undefined) update.contentHe = sanitizeContent(b.contentHe, 20000);
    if (b.contentAr !== undefined) update.contentAr = sanitizeContent(b.contentAr, 20000);

    if (b.isActive !== undefined) update.isActive = b.isActive;
    if (b.sortOrder !== undefined) update.sortOrder = b.sortOrder;

    // Avoid no-op update (optional)
    if (!Object.keys(update).length) {
      const current = await ContentPage.findById(oid).lean();
      return sendOk(res, mapPage(current, req.lang));
    }

    const item = await ContentPage.findByIdAndUpdate(oid, update, {
      new: true,
      runValidators: true,
    });

    if (!item) return safeNotFound(res);

    return sendOk(res, mapPage(item, req.lang));
  })
);

/**
 * PATCH /api/admin/content/pages/:id/publish
 */
router.patch(
  "/pages/:id/publish",
  validate(publishSchema),
  asyncHandler(async (req, res) => {
    const id = String(req.validated.params.id);
    const oid = toObjectId(id);
    const { isActive } = req.validated.body;

    const item = await ContentPage.findByIdAndUpdate(
      oid,
      { $set: { isActive } },
      { new: true, runValidators: true }
    );

    if (!item) return safeNotFound(res);

    return sendOk(res, mapPage(item, req.lang));
  })
);

/**
 * DELETE /api/admin/content/pages/:id
 */
router.delete(
  "/pages/:id",
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    const id = String(req.validated.params.id);
    const oid = toObjectId(id);

    const item = await ContentPage.findByIdAndDelete(oid);
    if (!item) return safeNotFound(res);

    return sendOk(res, { deleted: true, id: item._id });
  })
);

export default router;
