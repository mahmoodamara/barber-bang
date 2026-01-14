// src/api/routes/reviews.routes.js
import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { validate } from "../../middlewares/validate.js";

import {
  createReviewSchema,
  updateReviewSchema,
} from "../../validators/review.validators.js";

import {
  listFeatured,
  listForProduct,
  summaryForProduct,
  createForProduct,
  updateMine,
  deleteMine,
} from "../../controllers/reviews.controller.js";

const router = Router();

/**
 * Base mount (recommended in app.js):
 *   app.use("/api/v1/reviews", reviewsRoutes);
 *
 * Endpoints:
 *   GET    /api/v1/reviews/products/:productId
 *   GET    /api/v1/reviews/products/:productId/summary
 *   POST   /api/v1/reviews/products/:productId
 *   PATCH  /api/v1/reviews/:id
 *   DELETE /api/v1/reviews/:id
 */

// --------------------
// Public

router.get(
  "/featured",
  endpointLimiterMongo({
    scope: "reviews:featured_public",
    windowMs: 60_000,
    max: 120,
    messageCode: "REVIEWS_RATE_LIMIT",
  }),
  asyncHandler(listFeatured),
);

// --------------------
router.get(
  "/products/:productId",
  endpointLimiterMongo({
    scope: "reviews:list_public",
    windowMs: 60_000,
    max: 120,
    messageCode: "REVIEWS_RATE_LIMIT",
  }),
  asyncHandler(listForProduct),
);

router.get(
  "/products/:productId/summary",
  endpointLimiterMongo({
    scope: "reviews:summary_public",
    windowMs: 60_000,
    max: 240,
    messageCode: "REVIEWS_RATE_LIMIT",
  }),
  asyncHandler(summaryForProduct),
);

// --------------------
// Authenticated user
// --------------------
router.post(
  "/products/:productId",
  requireAuth,
  endpointLimiterMongo({
    scope: "reviews:create",
    windowMs: 60_000,
    max: 10,
    messageCode: "REVIEWS_CREATE_RATE_LIMIT",
  }),
  validate(createReviewSchema),
  asyncHandler(createForProduct),
);

router.patch(
  "/:id",
  requireAuth,
  endpointLimiterMongo({
    scope: "reviews:update",
    windowMs: 60_000,
    max: 20,
    messageCode: "REVIEWS_UPDATE_RATE_LIMIT",
  }),
  validate(updateReviewSchema),
  asyncHandler(updateMine),
);

router.delete(
  "/:id",
  requireAuth,
  endpointLimiterMongo({
    scope: "reviews:delete",
    windowMs: 60_000,
    max: 20,
    messageCode: "REVIEWS_DELETE_RATE_LIMIT",
  }),
  asyncHandler(deleteMine),
);

export default router;
