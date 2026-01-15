// src/api/routes/categories.routes.js
// ALIAS ROUTES for frontend guide compatibility
// Maps /api/v1/categories/* to existing catalog handlers

import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import {
  listCategories,
  listCategoriesTree,
} from "../../controllers/catalog.controller.js";
import { getCategoryBySlug } from "../../controllers/catalogV2.controller.js";

const router = Router();

/**
 * Alias: GET /api/v1/categories
 * Maps to existing catalog categories list
 */
router.get(
  "/",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(listCategories),
);

/**
 * Alias: GET /api/v1/categories/tree
 * Maps to existing catalog categories tree
 */
router.get(
  "/tree",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(listCategoriesTree),
);

/**
 * Alias: GET /api/v1/categories/:slug
 * New endpoint: get category by slug
 */
router.get(
  "/:slug",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    next();
  },
  asyncHandler(getCategoryBySlug),
);

export default router;
