// src/api/routes/brands.routes.js
// ALIAS ROUTES for frontend guide compatibility
// Maps /api/v1/brands/* to existing catalog handlers

import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { listBrands } from "../../controllers/catalog.controller.js";
import { getBrandBySlug } from "../../controllers/catalogV2.controller.js";

const router = Router();

/**
 * Alias: GET /api/v1/brands
 * Maps to existing catalog brands list
 */
router.get(
  "/",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    next();
  },
  asyncHandler(listBrands),
);

/**
 * Alias: GET /api/v1/brands/:slug
 * New endpoint: get brand info by slug
 */
router.get(
  "/:slug",
  (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    next();
  },
  asyncHandler(getBrandBySlug),
);

export default router;
