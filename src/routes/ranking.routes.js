// src/routes/ranking.routes.js
// Server-side ranking endpoints for home sections.
// These endpoints compute ranking on the server - client cannot pass sortBy/order/sortDir.

import express from "express";

import { validate } from "../middleware/validate.js";
import { createLimiter } from "../middleware/rateLimit.js";
import { sendOk, sendError, setCacheHeaders } from "../utils/response.js";
import { mapRankingProductCard, mapProductListItem } from "../utils/mapProduct.js";
import { withCache, buildRankingCacheKey } from "../utils/cache.js";

import {
  bestSellersSchema,
  mostPopularSchema,
  topRatedSchema,
  featuredSchema,
  newArrivalsSchema,
  normalizeRankingQuery,
} from "../schemas/ranking.schemas.js";

import {
  getBestSellers,
  getMostPopular,
  getTopRated,
  getFeaturedProducts,
  getNewArrivals,
} from "../services/ranking-queries.service.js";

const router = express.Router();

// Rate limit for ranking endpoints (generous but protected)
const limitRanking = createLimiter({
  windowMs: 60_000,
  limit: 60,
  messageCode: "RANKING_RATE_LIMITED",
  messageText: "Too many ranking requests. Please slow down.",
});

// Cache TTL configuration (in milliseconds)
const CACHE_TTL = {
  bestSellers: 60_000, // 60 seconds
  mostPopular: 60_000, // 60 seconds
  topRated: 90_000, // 90 seconds (changes less frequently)
  featured: 120_000, // 2 minutes
  newArrivals: 30_000, // 30 seconds (more dynamic)
};

/**
 * ============================================================================
 * GET /api/v1/products/best-sellers
 * Returns products ranked by sales volume in the last 30 days.
 * ============================================================================
 */
router.get(
  "/best-sellers",
  limitRanking,
  validate(bestSellersSchema),
  async (req, res) => {
    try {
      const { page, limit, categoryId } = normalizeRankingQuery(req.validated?.query || req.query);
      const lang = req.lang || "he";
      const now = new Date();

      const cacheKey = buildRankingCacheKey("best-sellers", { page, limit, categoryId, lang });

      const { data: result } = await withCache(
        cacheKey,
        () => getBestSellers({ page, limit, categoryId, now }),
        { ttlMs: CACHE_TTL.bestSellers }
      );

      const mappedItems = result.items.map((p) => mapRankingProductCard(p, { lang, now }));
      const pages = result.pages || Math.ceil(result.total / result.limit);

      setCacheHeaders(res, {
        sMaxAge: 60,
        staleWhileRevalidate: 120,
        vary: "Accept-Language",
      });
      return sendOk(
        res,
        { items: mappedItems },
        {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages,
          hasNext: result.page < pages,
          hasPrev: result.page > 1,
        }
      );
    } catch (err) {
      console.error("[ranking] best-sellers error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch best sellers");
    }
  }
);

/**
 * ============================================================================
 * GET /api/v1/products/most-popular
 * Returns products ranked by popularity score (views, cart adds, wishlists).
 * ============================================================================
 */
router.get(
  "/most-popular",
  limitRanking,
  validate(mostPopularSchema),
  async (req, res) => {
    try {
      const { page, limit, categoryId } = normalizeRankingQuery(req.validated?.query || req.query);
      const lang = req.lang || "he";
      const now = new Date();

      const cacheKey = buildRankingCacheKey("most-popular", { page, limit, categoryId, lang });

      const { data: result } = await withCache(
        cacheKey,
        () => getMostPopular({ page, limit, categoryId, now }),
        { ttlMs: CACHE_TTL.mostPopular }
      );

      const mappedItems = result.items.map((p) => mapRankingProductCard(p, { lang, now }));
      const pages = result.pages || Math.ceil(result.total / result.limit);

      setCacheHeaders(res, {
        sMaxAge: 60,
        staleWhileRevalidate: 120,
        vary: "Accept-Language",
      });
      return sendOk(
        res,
        { items: mappedItems },
        {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages,
          hasNext: result.page < pages,
          hasPrev: result.page > 1,
        }
      );
    } catch (err) {
      console.error("[ranking] most-popular error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch most popular products");
    }
  }
);

/**
 * ============================================================================
 * GET /api/v1/products/top-rated
 * Returns products ranked by Bayesian-weighted review ratings.
 * ============================================================================
 */
router.get(
  "/top-rated",
  limitRanking,
  validate(topRatedSchema),
  async (req, res) => {
    try {
      const { page, limit, categoryId } = normalizeRankingQuery(req.validated?.query || req.query);
      const lang = req.lang || "he";
      const now = new Date();

      const cacheKey = buildRankingCacheKey("top-rated", { page, limit, categoryId, lang });

      const { data: result } = await withCache(
        cacheKey,
        () => getTopRated({ page, limit, categoryId, now }),
        { ttlMs: CACHE_TTL.topRated }
      );

      const mappedItems = result.items.map((p) => mapRankingProductCard(p, { lang, now }));
      const pages = result.pages || Math.ceil(result.total / result.limit);

      setCacheHeaders(res, {
        sMaxAge: 60,
        staleWhileRevalidate: 120,
        vary: "Accept-Language",
      });
      return sendOk(
        res,
        { items: mappedItems },
        {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages,
          hasNext: result.page < pages,
          hasPrev: result.page > 1,
        }
      );
    } catch (err) {
      console.error("[ranking] top-rated error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch top rated products");
    }
  }
);

/**
 * ============================================================================
 * GET /api/v1/products/featured
 * Returns auto-generated featured products based on combined ranking signals.
 * ============================================================================
 */
router.get(
  "/featured",
  limitRanking,
  validate(featuredSchema),
  async (req, res) => {
    try {
      const { page, limit, categoryId } = normalizeRankingQuery(req.validated?.query || req.query);
      const lang = req.lang || "he";
      const now = new Date();

      const cacheKey = buildRankingCacheKey("featured", { page, limit, categoryId, lang });

      const { data: result } = await withCache(
        cacheKey,
        () => getFeaturedProducts({ page, limit, categoryId, now }),
        { ttlMs: CACHE_TTL.featured }
      );

      const mappedItems = result.items.map((p) => mapProductListItem(p, { lang, now }));
      const pages = result.pages || Math.ceil(result.total / result.limit);

      setCacheHeaders(res, {
        sMaxAge: 60,
        staleWhileRevalidate: 120,
        vary: "Accept-Language",
      });
      return sendOk(
        res,
        { items: mappedItems },
        {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages,
          hasNext: result.page < pages,
          hasPrev: result.page > 1,
        }
      );
    } catch (err) {
      console.error("[ranking] featured error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch featured products");
    }
  }
);

/**
 * ============================================================================
 * GET /api/v1/products/new-arrivals
 * Returns newest products, with in-stock items boosted to the top.
 * ============================================================================
 */
router.get(
  "/new-arrivals",
  limitRanking,
  validate(newArrivalsSchema),
  async (req, res) => {
    try {
      const { page, limit, categoryId } = normalizeRankingQuery(req.validated?.query || req.query);
      const lang = req.lang || "he";
      const now = new Date();

      const cacheKey = buildRankingCacheKey("new-arrivals", { page, limit, categoryId, lang });

      const { data: result } = await withCache(
        cacheKey,
        () => getNewArrivals({ page, limit, categoryId, now }),
        { ttlMs: CACHE_TTL.newArrivals }
      );

      const mappedItems = result.items.map((p) => mapProductListItem(p, { lang, now }));
      const pages = result.pages || Math.ceil(result.total / result.limit);

      setCacheHeaders(res, {
        sMaxAge: 60,
        staleWhileRevalidate: 120,
        vary: "Accept-Language",
      });
      return sendOk(
        res,
        { items: mappedItems },
        {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages,
          hasNext: result.page < pages,
          hasPrev: result.page > 1,
        }
      );
    } catch (err) {
      console.error("[ranking] new-arrivals error:", err);
      return sendError(res, 500, "INTERNAL_ERROR", "Failed to fetch new arrivals");
    }
  }
);

export default router;
