import express from "express";
import { z } from "zod";

import { Category } from "../models/Category.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { t } from "../utils/i18n.js";

const router = express.Router();

router.get("/", async (req, res) => {
  const items = await Category.find().sort({ createdAt: -1 });

  const data = items.map((c) => ({
    _id: c._id,
    nameHe: c.nameHe || c.name || "",
    nameAr: c.nameAr || "",
    // unified field based on req.lang (he default)
    name: t(c, "name", req.lang),
    slug: c.slug || "",
  }));

  res.json({ ok: true, data });
});

const createSchema = z.object({
  body: z.object({
    nameHe: z.string().min(2).max(80).optional(),
    nameAr: z.string().max(80).optional(),
    name: z.string().min(2).max(80).optional(),
    slug: z.string().max(60).optional(),
  }),
});

router.post("/", requireAuth(), requireRole("admin"), validate(createSchema), async (req, res) => {
  const { name, nameHe, nameAr, slug } = req.validated.body;

  const item = await Category.create({
    nameHe: nameHe || name || "",
    nameAr: nameAr || "",
    name: name || nameHe || "",
    slug: slug || "",
  });

  // Return unified "name" in addition to stored bilingual fields
  res.status(201).json({
    ok: true,
    data: {
      ...item.toObject(),
      name: t(item, "name", req.lang),
    },
  });
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    nameHe: z.string().min(2).max(80).optional(),
    nameAr: z.string().max(80).optional(),
    name: z.string().min(2).max(80).optional(),
    slug: z.string().max(60).optional(),
  }),
});

router.put("/:id", requireAuth(), requireRole("admin"), validate(updateSchema), async (req, res) => {
  const item = await Category.findByIdAndUpdate(req.params.id, req.validated.body, { new: true });
  if (!item) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Category not found" },
    });
  }

  res.json({
    ok: true,
    data: {
      ...item.toObject(),
      name: t(item, "name", req.lang),
    },
  });
});

router.delete("/:id", requireAuth(), requireRole("admin"), async (req, res) => {
  const item = await Category.findByIdAndDelete(req.params.id);
  if (!item) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Category not found" },
    });
  }

  res.json({ ok: true, data: { deleted: true } });
});

export default router;
