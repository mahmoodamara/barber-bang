// src/routes/content.routes.js
import express from "express";
import { z } from "zod";

import { ContentPage } from "../models/ContentPage.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { t } from "../utils/i18n.js";
import { sanitizeRichText } from "../utils/sanitize.js";

const router = express.Router();

function errorPayload(req, code, message) {
  return {
    ok: false,
    success: false,
    error: {
      code,
      message,
      requestId: getRequestId(req),
      path: req.originalUrl || req.url || "",
    },
  };
}

function okPayload(data) {
  return { ok: true, success: true, data };
}

const listSchema = z.object({
  query: z
    .object({
      // lang is typically handled by langMiddleware, but we validate anyway defensively
      lang: z.enum(["he", "ar"]).optional(),
    })
    .optional(),
});

const slugSchema = z.object({
  params: z.object({
    slug: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9-]+$/i, "Invalid slug format"),
  }),
});

function normalizeSlug(raw) {
  return String(raw || "").trim().toLowerCase();
}

function mapPage(p, lang) {
  const title = t(p, "title", lang) || "";
  const content = t(p, "content", lang) || "";

  return {
    id: p._id,
    _id: p._id, // additive (backward compatible)

    slug: p.slug,

    titleHe: p.titleHe || "",
    titleAr: p.titleAr || "",
    title,

    // Defense-in-depth: sanitize on output to prevent stored XSS
    // Even if admin stored unsafe HTML, API will remove scripts/events/etc.
    contentHe: sanitizeRichText(p.contentHe || ""),
    contentAr: sanitizeRichText(p.contentAr || ""),
    content: sanitizeRichText(content),

    isActive: Boolean(p.isActive),
    sortOrder: Number(p.sortOrder || 0),

    updatedAt: p.updatedAt,
  };
}

/**
 * GET /api/content/pages?lang=he|ar
 * Returns: list of pages (Israeli required pages)
 */
router.get("/pages", validate(listSchema), async (req, res) => {
  try {
    const pages = await ContentPage.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const data = pages.map((p) => mapPage(p, req.lang));

    return res.json(okPayload(data));
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL_ERROR", "Failed to load content pages"));
  }
});

/**
 * GET /api/content/pages/:slug?lang=he|ar
 * Optional endpoint (single page by slug)
 */
router.get("/pages/:slug", validate(slugSchema), async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    const page = await ContentPage.findOne({ slug, isActive: true }).lean();
    if (!page) {
      return res.status(404).json(errorPayload(req, "NOT_FOUND", "Content page not found"));
    }

    return res.json(okPayload(mapPage(page, req.lang)));
  } catch (e) {
    return res.status(500).json(errorPayload(req, "INTERNAL_ERROR", "Failed to load content page"));
  }
});

export default router;
