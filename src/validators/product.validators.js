// src/validators/product.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening goals:
 * - Trim/normalize strings (defensive)
 * - Enforce slug format when provided (URL-safe)
 * - Avoid unbounded / unsafe "attributes: record(any)" (mass-assignment & injection surface)
 *   -> allow only JSON-serializable primitives/arrays/objects with size constraints
 * - Limit images array size + normalize URLs
 * - Ensure categoryIds unique
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);
const trimmedOptional = (max) => z.string().trim().max(max).optional();

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase and URL-safe (a-z, 0-9, '-')");

const urlSchema = z.string().trim().url();

const uniqueObjectIdArray = z
  .array(objectId)
  .max(50)
  .transform((arr) => Array.from(new Set(arr.map(String))))
  .transform((arr) => arr.map((id) => id)); // keep strings as-is (objectId validator already ensured)

const imagesSchema = z.array(urlSchema).max(30);

// A safe JSON-like schema for attributes.
// NOTE: This is strict on purpose. If you need richer shapes, define explicit attribute keys instead.
const jsonPrimitive = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const jsonValue = z.lazy(() =>
  z.union([
    jsonPrimitive,
    z.array(jsonValue).max(200),
    z.record(z.string().max(120), jsonValue),
  ]),
);

const attributesSchema = z
  .record(z.string().max(120), jsonValue)
  .optional()
  .refine(
    (obj) => {
      // coarse cap on number of keys
      const keys = obj ? Object.keys(obj) : [];
      return keys.length <= 200;
    },
    { message: "attributes has too many keys (max 200)" },
  );

export const createProductSchema = z.object({
  body: z.object({
    nameHe: trimmed(1, 180),
    nameAr: trimmed(0, 180).optional().nullable(),

    descriptionHe: z.string().trim().max(30000).optional().nullable(),
    descriptionAr: z.string().trim().max(30000).optional().nullable(),

    brand: trimmedOptional(140).nullable(),

    categoryIds: uniqueObjectIdArray.optional(),

    images: imagesSchema.optional(),

    // Optional on create if you auto-generate slugs server-side
    slug: slugSchema.optional().nullable(),

    isActive: z.boolean().optional(),

    attributes: attributesSchema,
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    nameHe: trimmed(1, 180).optional(),
    nameAr: trimmed(0, 180).optional().nullable(),

    descriptionHe: z.string().trim().max(30000).optional().nullable(),
    descriptionAr: z.string().trim().max(30000).optional().nullable(),

    brand: trimmedOptional(140).nullable().optional(),

    categoryIds: uniqueObjectIdArray.optional(),

    images: imagesSchema.optional(),

    slug: slugSchema.optional().nullable(),

    isActive: z.boolean().optional(),

    attributes: attributesSchema,
  }),
});
