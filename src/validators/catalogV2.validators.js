// src/validators/catalogV2.validators.js
// Extended validators for frontend guide compatibility

import { z } from "zod";
import { objectId } from "./_common.js";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format");

const idOrSlug = z.union([objectId, slugSchema]);
const idOrString = z.union([objectId, z.string().trim().min(1).max(120)]);

/**
 * Sort value mapping for guide compatibility
 * Guide expects: newest|bestselling|price_asc|price_desc|rating_desc|name_asc
 * Existing: new|popular
 * 
 * Mapping:
 * - newest -> new
 * - bestselling -> popular
 * - price_asc -> price_asc (new)
 * - price_desc -> price_desc (new)
 * - rating_desc -> rating_desc (new)
 * - name_asc -> name_asc (new)
 * 
 * Keep backward compat: new/popular still work
 */
const sortValues = z.enum([
  "new",
  "popular",
  "newest",
  "bestselling",
  "price_asc",
  "price_desc",
  "rating_desc",
  "name_asc",
]);

/**
 * Helper to parse comma-separated ObjectIds
 */
const commaSeparatedIds = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  });

/**
 * Helper to parse comma-separated strings
 */
const commaSeparatedStrings = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  });

/**
 * Extended product list query schema for guide compatibility
 */
export const listProductsQuerySchemaV2 = z
  .object({
    query: z
      .object({
        // Pagination
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),

        // Sorting (extended)
        sort: sortValues.optional().default("new"),

        // Text search
        q: z.string().trim().max(120).optional(),
        search: z.string().trim().max(120).optional(),

        // Language
        lang: z.enum(["he", "ar"]).optional(),

        // Category (existing - by fullSlug)
        category: idOrString.optional(),

        // CategoryIds (new - multi, comma-separated)
        categoryIds: commaSeparatedIds,

        // Brand (existing - single)
        brand: z.string().trim().max(140).optional(),

        // Brands (new - multi, comma-separated)
        brands: commaSeparatedStrings,

        // Price range (minor units)
        minPrice: z.coerce.number().int().min(0).optional(),
        maxPrice: z.coerce.number().int().min(0).optional(),

        // Rating filter
        minRating: z.coerce.number().min(0).max(5).optional(),

        // Stock filter
        inStock: z
          .string()
          .optional()
          .transform((v) => {
            if (v === undefined || v === null || v === "") return undefined;
            return v === "true" || v === "1";
          }),

        // Sale filter
        onSale: z
          .string()
          .optional()
          .transform((v) => {
            if (v === undefined || v === null || v === "") return undefined;
            return v === "true" || v === "1";
          }),

        // Featured filter
        featured: z
          .string()
          .optional()
          .transform((v) => {
            if (v === undefined || v === null || v === "") return undefined;
            return v === "true" || v === "1";
          }),
      })
      .strict()
      .optional()
      .default({}),
    params: z.any().optional(),
    body: z.any().optional(),
    headers: z.any().optional(),
  })
  .strict();

/**
 * Extended product params schema (for :idOrSlug and :slug routes)
 */
export const getProductParamsSchemaV2 = z
  .object({
    params: z
      .object({
        idOrSlug: idOrSlug.optional(),
        slug: z.string().trim().min(1).max(200).optional(),
        id: idOrSlug.optional(),
      })
      .optional()
      .default({}),
    query: z.any().optional(),
    body: z.any().optional(),
    headers: z.any().optional(),
  })
  .strict();
