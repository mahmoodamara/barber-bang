// src/schemas/ranking.schemas.js
// Zod validation schemas for ranking endpoints.

import { z } from "zod";
import mongoose from "mongoose";

/**
 * Validate MongoDB ObjectId string.
 */
function isValidObjectId(val) {
  return mongoose.Types.ObjectId.isValid(String(val || ""));
}

/**
 * Shared query schema for all ranking endpoints.
 * Supports: page, limit, categoryId
 * IMPORTANT: sortBy/order/sortDir are NOT allowed (server-side ranking only)
 */
const rankingQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .transform((v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
      }),
    limit: z
      .string()
      .optional()
      .transform((v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 50) : 12;
      }),
    categoryId: z
      .string()
      .optional()
      .refine((v) => !v || isValidObjectId(v), {
        message: "Invalid categoryId format",
      }),
    // Allow lang query param (used by middleware for i18n)
    lang: z.enum(["he", "ar"]).optional(),
  })
  .strict(); // Reject unknown keys (no sortBy, order, sortDir allowed)

/**
 * Best Sellers endpoint schema.
 * GET /api/v1/products/best-sellers?page&limit&categoryId
 */
export const bestSellersSchema = z.object({
  query: rankingQuerySchema,
});

/**
 * Most Popular endpoint schema.
 * GET /api/v1/products/most-popular?page&limit&categoryId
 */
export const mostPopularSchema = z.object({
  query: rankingQuerySchema,
});

/**
 * Top Rated endpoint schema.
 * GET /api/v1/products/top-rated?page&limit&categoryId
 */
export const topRatedSchema = z.object({
  query: rankingQuerySchema,
});

/**
 * Featured Products endpoint schema.
 * GET /api/v1/products/featured?page&limit&categoryId
 */
export const featuredSchema = z.object({
  query: rankingQuerySchema,
});

/**
 * New Arrivals endpoint schema.
 * GET /api/v1/products/new-arrivals?page&limit&categoryId
 */
export const newArrivalsSchema = z.object({
  query: rankingQuerySchema,
});

/**
 * Validate and normalize ranking query params.
 * @param {object} query - Raw query params
 * @returns {{ page: number, limit: number, categoryId: string | null }}
 */
export function normalizeRankingQuery(query) {
  const page = Math.max(1, Math.floor(Number(query?.page || 1)));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(query?.limit || 12))));
  const categoryId = isValidObjectId(query?.categoryId) ? String(query.categoryId) : null;

  return { page, limit, categoryId };
}
