// src/api/routes/wishlist.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth } from "../../middlewares/auth.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  getMyWishlist,
  addWishlist,
  removeWishlist,
  clearMyWishlist,
} from "../../controllers/wishlist.controller.js";

import { addWishlistItemSchema } from "../../validators/wishlist.validators.js";

const router = Router();

router.use(requireAuth);

// GET /api/v1/wishlist?expand=1&lang=he|ar
router.get(
  "/",
  endpointLimiterMongo({ scope: "wishlist:get", windowMs: 60_000, max: 120, messageCode: "WISHLIST_RATE_LIMIT" }),
  asyncHandler(getMyWishlist),
);

// POST /api/v1/wishlist/items
router.post(
  "/items",
  endpointLimiterMongo({ scope: "wishlist:add", windowMs: 60_000, max: 60, messageCode: "WISHLIST_RATE_LIMIT" }),
  validate(addWishlistItemSchema),
  idempotencyEnforce({ routeName: "wishlist:add", required: false }),
  asyncHandler(addWishlist),
);

// DELETE /api/v1/wishlist/items/:productId?variantId=...
router.delete(
  "/items/:productId",
  endpointLimiterMongo({ scope: "wishlist:remove", windowMs: 60_000, max: 90, messageCode: "WISHLIST_RATE_LIMIT" }),
  asyncHandler(removeWishlist),
);

// DELETE /api/v1/wishlist  (clear)
router.delete(
  "/",
  endpointLimiterMongo({ scope: "wishlist:clear", windowMs: 60_000, max: 20, messageCode: "WISHLIST_RATE_LIMIT" }),
  asyncHandler(clearMyWishlist),
);

export default router;
