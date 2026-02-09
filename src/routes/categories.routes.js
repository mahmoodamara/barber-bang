import express from "express";

import { Category } from "../models/Category.js";
import { t } from "../utils/i18n.js";
import { sendOk, sendError, setCacheHeaders } from "../utils/response.js";
import { withCache } from "../utils/cache.js";

const router = express.Router();

const CATEGORIES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CATEGORIES_SMAXAGE = 300;
const CATEGORIES_STALE_REVALIDATE = 600;

/**
 * Public categories list (read-only).
 * Category writes (create/update/delete) are done only via admin API: /api/admin/categories
 */
router.get("/", async (req, res) => {
  try {
    const lang = req.lang || "he";
    const key = `categories:${lang}`;
    const { data: cached } = await withCache(key, async () => {
      const items = await Category.find({ isActive: true })
        .sort({ sortOrder: 1, createdAt: -1 })
        .lean();
      return {
        items: items.map((c) => ({
          _id: c._id,
          nameHe: c.nameHe || c.name || "",
          nameAr: c.nameAr || "",
          name: t(c, "name", lang),
          slug: c.slug || "",
          imageUrl: c.imageUrl || "",
          parentId: c.parentId || null,
        })),
      };
    }, { ttlMs: CATEGORIES_CACHE_TTL_MS });

    setCacheHeaders(res, {
      sMaxAge: CATEGORIES_SMAXAGE,
      staleWhileRevalidate: CATEGORIES_STALE_REVALIDATE,
      vary: "Accept-Language",
    });
    return sendOk(res, cached, { total: cached.items.length });
  } catch (e) {
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch categories");
  }
});

export default router;
