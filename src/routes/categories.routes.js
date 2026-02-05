import express from "express";

import { Category } from "../models/Category.js";
import { t } from "../utils/i18n.js";
import { sendOk, sendError } from "../utils/response.js";

const router = express.Router();

/**
 * Public categories list (read-only).
 * Category writes (create/update/delete) are done only via admin API: /api/admin/categories
 */
router.get("/", async (req, res) => {
  try {
    const items = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    const data = items.map((c) => ({
      _id: c._id,
      nameHe: c.nameHe || c.name || "",
      nameAr: c.nameAr || "",
      name: t(c, "name", req.lang),
      slug: c.slug || "",
      imageUrl: c.imageUrl || "",
      parentId: c.parentId || null,
    }));

    return sendOk(res, { items: data }, { total: data.length });
  } catch (e) {
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch categories");
  }
});

export default router;
