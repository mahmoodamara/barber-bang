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

export const listProductsQuerySchema = z
  .object({
    query: z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        sort: z.enum(["new", "popular"]).optional().default("new"),
        q: z.string().trim().max(120).optional(),
        search: z.string().trim().max(120).optional(),
        lang: z.enum(["he", "ar"]).optional(),
        category: idOrString.optional(),
        brand: z.string().trim().max(140).optional(),
      })
      .strict(),
    params: z.any().optional(),
    body: z.any().optional(),
    headers: z.any().optional(),
  })
  .strict();

export const getProductParamsSchema = z
  .object({
    params: z
      .object({
        idOrSlug: idOrSlug,
      })
      .strict(),
    query: z.any().optional(),
    body: z.any().optional(),
    headers: z.any().optional(),
  })
  .strict();
