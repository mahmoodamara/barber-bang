// src/api/routes/products.routes.js
// ALIAS ROUTES for frontend guide compatibility
// Maps /api/v1/products/* to existing catalog handlers

import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth } from "../../middlewares/auth.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import {
  listProducts,
  getProduct,
} from "../../controllers/catalog.controller.js";
import {
  listProductsQuerySchemaV2,
  getProductParamsSchemaV2,
} from "../../validators/catalogV2.validators.js";

// Reviews controllers (for /products/:id/reviews alias)
import {
  listForProduct,
  summaryForProduct,
  createForProduct,
} from "../../controllers/reviews.controller.js";
import { createReviewSchema } from "../../validators/review.validators.js";

const router = Router();

/**
 * Alias: GET /api/v1/products
 * Maps to existing catalog products list with extended filters
 */
router.get(
  "/",
  validate(listProductsQuerySchemaV2),
  asyncHandler(listProducts),
);

/**
 * Alias: GET /api/v1/products/slug/:slug
 * Maps to existing product detail handler
 */
router.get(
  "/slug/:slug",
  validate(getProductParamsSchemaV2),
  asyncHandler(async (req, res, next) => {
    // Rewrite slug param to idOrSlug for the existing handler
    req.params.idOrSlug = req.params.slug;
    return getProduct(req, res, next);
  }),
);

/**
 * Alias: GET /api/v1/products/:id
 * Maps to existing product detail (idOrSlug)
 */
router.get(
  "/:idOrSlug",
  validate(getProductParamsSchemaV2),
  asyncHandler(getProduct),
);

/* ------------------------------------------------------------------ */
/* Reviews under products (alias to /reviews/products/:productId)      */
/* ------------------------------------------------------------------ */

/**
 * Alias: GET /api/v1/products/:id/reviews
 * Maps to existing reviews list for product
 */
router.get(
  "/:id/reviews",
  endpointLimiterMongo({
    scope: "reviews:list_public",
    windowMs: 60_000,
    max: 120,
    messageCode: "REVIEWS_RATE_LIMIT",
  }),
  asyncHandler(async (req, res, next) => {
    // Map :id to :productId for reviews controller
    req.params.productId = req.params.id;
    return listForProduct(req, res, next);
  }),
);

/**
 * Alias: GET /api/v1/products/:id/reviews/summary
 * Maps to existing reviews summary for product
 */
router.get(
  "/:id/reviews/summary",
  endpointLimiterMongo({
    scope: "reviews:summary_public",
    windowMs: 60_000,
    max: 240,
    messageCode: "REVIEWS_RATE_LIMIT",
  }),
  asyncHandler(async (req, res, next) => {
    req.params.productId = req.params.id;
    return summaryForProduct(req, res, next);
  }),
);

/**
 * Alias: POST /api/v1/products/:id/reviews
 * Maps to existing create review for product
 */
router.post(
  "/:id/reviews",
  requireAuth,
  endpointLimiterMongo({
    scope: "reviews:create",
    windowMs: 60_000,
    max: 10,
    messageCode: "REVIEWS_CREATE_RATE_LIMIT",
  }),
  validate(createReviewSchema),
  asyncHandler(async (req, res, next) => {
    req.params.productId = req.params.id;
    return createForProduct(req, res, next);
  }),
);

export default router;
