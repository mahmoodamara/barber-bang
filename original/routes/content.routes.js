// src/routes/content.routes.js
import express from "express";
import { z } from "zod";

import { ContentPage } from "../models/ContentPage.js";
import { validate } from "../middleware/validate.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

const listSchema = z.object({
  query: z
    .object({
      lang: z.string().optional(), // handled by langMiddleware already
    })
    .optional(),
});

const slugSchema = z.object({
  params: z.object({
    slug: z.string().min(2).max(80),
  }),
});

function mapPage(p, lang) {
  return {
    id: p._id,
    _id: p._id, // additive

    slug: p.slug,

    titleHe: p.titleHe || "",
    titleAr: p.titleAr || "",
    title: t(p, "title", lang),

    contentHe: p.contentHe || "",
    contentAr: p.contentAr || "",
    content: t(p, "content", lang),

    isActive: p.isActive,
    sortOrder: p.sortOrder,

    updatedAt: p.updatedAt,
  };
}

/**
 * GET /api/content/pages?lang=he|ar
 * Returns: list of pages (Israeli required pages)
 */
router.get("/pages", validate(listSchema), async (req, res) => {
  const pages = await ContentPage.find({ isActive: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  const data = pages.map((p) => mapPage(p, req.lang));

  res.json({ ok: true, data });
});

/**
 * GET /api/content/pages/:slug?lang=he|ar
 * Optional endpoint (single page by slug)
 */
router.get("/pages/:slug", validate(slugSchema), async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();

  const page = await ContentPage.findOne({ slug, isActive: true }).lean();
  if (!page) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Content page not found" },
    });
  }

  res.json({ ok: true, data: mapPage(page, req.lang) });
});

export default router;
