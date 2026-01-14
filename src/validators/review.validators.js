// src/validators/review.validators.js
import { z } from "zod";
import { objectId } from "./_common.js";

/**
 * Hardening goals:
 * - Use shared objectId validator (single source of truth)
 * - Ensure schemas match validate(...) convention: { params, query, body }
 * - Normalize/trim strings and clamp sizes
 * - Robust boolean parsing for query params
 * - Enforce sort enum + keep defaults consistent with service
 * - Admin moderation payloads validated and explicit
 */

const trimmed = (min, max) => z.string().trim().min(min).max(max);

const boolFromQuery = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
  });

/* ---------------------------- */
/* User create/update review     */
/* ---------------------------- */

export const createReviewSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5),
    title: trimmed(0, 80).optional().default(""),
    body: trimmed(0, 2000).optional().default(""),
    lang: z.enum(["he", "ar"]).optional().default("he"),
  }),
});

export const updateReviewSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    title: trimmed(0, 80).optional(),
    body: trimmed(0, 2000).optional(),
    lang: z.enum(["he", "ar"]).optional(),
  }),
});

/* ---------------------------- */
/* Public list product reviews   */
/* ---------------------------- */

export const listProductReviewsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    sort: z.enum(["recent", "rating_desc", "rating_asc"]).default("recent"),
    lang: z.enum(["he", "ar"]).optional(),
    verifiedOnly: boolFromQuery.optional(),
    rating: z.coerce.number().int().min(1).max(5).optional(),
  }),
});

/* ---------------------------- */
/* Admin list/moderation         */
/* ---------------------------- */

export const adminListReviewsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(["pending", "approved", "rejected", "deleted"]).optional(),
    productId: objectId.optional(),
    userId: objectId.optional(),
  }),
});

export const adminApproveReviewParamsSchema = z.object({
  params: z.object({
    id: objectId, // reviewId
  }),
});

export const adminRejectSchema = z.object({
  params: z.object({
    id: objectId, // reviewId
  }),
  body: z.object({
    reason: trimmed(1, 300),
  }),
});
