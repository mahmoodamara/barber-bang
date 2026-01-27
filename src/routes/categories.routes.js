import express from "express";
import { z } from "zod";

import { Category } from "../models/Category.js";
import { requireAuth, requirePermission, PERMISSIONS } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getRequestId } from "../middleware/error.js";
import { t } from "../utils/i18n.js";
import { sendOk, sendCreated, sendError } from "../utils/response.js";

const router = express.Router();

// function errorPayload removed, using sendError directly

router.get("/", async (req, res) => {
  try {
    const items = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    const data = items.map((c) => ({
      _id: c._id,
      nameHe: c.nameHe || c.name || "",
      nameAr: c.nameAr || "",
      // unified field based on req.lang (he default)
      name: t(c, "name", req.lang),
      slug: c.slug || "",
      imageUrl: c.imageUrl || "",
    }));

    return sendOk(res, { items: data }, { total: data.length });
  } catch (e) {
    return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch categories");
  }
});

const createSchema = z.object({
  body: z.object({
    nameHe: z.string().min(2).max(80).optional(),
    nameAr: z.string().max(80).optional(),
    name: z.string().min(2).max(80).optional(),
    slug: z.string().max(60).optional(),
    imageUrl: z.string().max(500).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    descriptionHe: z.string().max(500).optional(),
    descriptionAr: z.string().max(500).optional(),
    metaTitleHe: z.string().max(70).optional(),
    metaTitleAr: z.string().max(70).optional(),
    metaDescriptionHe: z.string().max(160).optional(),
    metaDescriptionAr: z.string().max(160).optional(),
  }),
});

router.post("/", requireAuth(), requirePermission(PERMISSIONS.PRODUCTS_WRITE), validate(createSchema), async (req, res) => {
  const {
    name,
    nameHe,
    nameAr,
    slug,
    imageUrl,
    isActive,
    sortOrder,
    descriptionHe,
    descriptionAr,
    metaTitleHe,
    metaTitleAr,
    metaDescriptionHe,
    metaDescriptionAr,
  } = req.validated.body;

  const normalizedSlug = String(slug || "").trim();

  const item = await Category.create({
    nameHe: nameHe || name || "",
    nameAr: nameAr || "",
    name: name || nameHe || "",
    slug: normalizedSlug || undefined,
    imageUrl: imageUrl || "",
    isActive: isActive ?? true,
    sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
    descriptionHe: descriptionHe || "",
    descriptionAr: descriptionAr || "",
    metaTitleHe: metaTitleHe || "",
    metaTitleAr: metaTitleAr || "",
    metaDescriptionHe: metaDescriptionHe || "",
    metaDescriptionAr: metaDescriptionAr || "",
  });

  // Return unified "name" in addition to stored bilingual fields
  sendCreated(res, {
    ...item.toObject(),
    name: t(item, "name", req.lang),
  });
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    nameHe: z.string().min(2).max(80).optional(),
    nameAr: z.string().max(80).optional(),
    name: z.string().min(2).max(80).optional(),
    slug: z.string().max(60).optional(),
    imageUrl: z.string().max(500).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    descriptionHe: z.string().max(500).optional(),
    descriptionAr: z.string().max(500).optional(),
    metaTitleHe: z.string().max(70).optional(),
    metaTitleAr: z.string().max(70).optional(),
    metaDescriptionHe: z.string().max(160).optional(),
    metaDescriptionAr: z.string().max(160).optional(),
  }),
});

router.put("/:id", requireAuth(), requirePermission(PERMISSIONS.PRODUCTS_WRITE), validate(updateSchema), async (req, res) => {
  const patch = { ...req.validated.body };
  if ("slug" in patch) {
    const normalizedSlug = String(patch.slug || "").trim();
    if (!normalizedSlug) {
      delete patch.slug;
    } else {
      patch.slug = normalizedSlug;
    }
  }

  const item = await Category.findByIdAndUpdate(req.params.id, patch, { new: true });
  if (!item) {
    return sendError(res, 404, "NOT_FOUND", "Category not found");
  }

  sendOk(res, {
    ...item.toObject(),
    name: t(item, "name", req.lang),
  });
});

router.delete("/:id", requireAuth(), requirePermission(PERMISSIONS.PRODUCTS_WRITE), async (req, res) => {
  const item = await Category.findByIdAndDelete(req.params.id);
  if (!item) {
    return sendError(res, 404, "NOT_FOUND", "Category not found");
  }

  sendOk(res, { deleted: true });
});

export default router;
