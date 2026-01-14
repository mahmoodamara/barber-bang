// src/validators/category.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening notes:
 * - Trim + normalize basic strings (defensive)
 * - Slug validation: lower-case, URL-safe, no spaces (prevents weird routing/SEO bugs)
 * - ParentId cannot equal the category id on update (basic cycle guard)
 *   (Full cycle detection should be in service, but this prevents the simplest self-parent bug)
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase and URL-safe (a-z, 0-9, '-')");

export const createCategorySchema = z.object({
  body: z.object({
    nameHe: trimmed(1, 140),
    nameAr: trimmed(0, 140).optional().nullable(),
    slug: slugSchema,
    parentId: objectId.optional().nullable(),
    sortOrder: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const updateCategorySchema = z
  .object({
    params: z.object({
      id: objectId,
    }),
    body: z.object({
      nameHe: trimmed(1, 140).optional(),
      nameAr: trimmed(0, 140).optional().nullable(),
      slug: slugSchema.optional(),
      parentId: objectId.optional().nullable(),
      sortOrder: z.number().int().min(0).optional(),
      isActive: z.boolean().optional(),
    }),
  })
  .superRefine((val, ctx) => {
    const id = val?.params?.id;
    const parentId = val?.body?.parentId;

    // Prevent simplest invalid tree cycle (self-parent)
    if (id && parentId && String(id) === String(parentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body", "parentId"],
        message: "parentId cannot equal category id",
      });
    }
  });
