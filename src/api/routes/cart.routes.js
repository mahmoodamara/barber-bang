// src/api/routes/cart.routes.js
import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth } from "../../middlewares/auth.js";

// Phase 6
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import { getMyCart, addItem, setQty, removeItem, clearMyCart } from "../../controllers/cart.controller.js";
import { addCartItemSchema, updateCartItemQtySchema } from "../../validators/cart.validators.js";

const router = Router();

router.use(requireAuth);

// GET /api/v1/cart?expand=1&lang=he|ar
router.get(
  "/",
  endpointLimiterMongo({ scope: "cart:get", windowMs: 60_000, max: 180, messageCode: "CART_RATE_LIMIT" }),
  asyncHandler(getMyCart),
);

// POST /api/v1/cart/items
router.post(
  "/items",
  endpointLimiterMongo({ scope: "cart:add", windowMs: 60_000, max: 90, messageCode: "CART_RATE_LIMIT" }),
  idempotencyEnforce({ routeName: "cart:add", required: true }),
  validate(addCartItemSchema),
  asyncHandler(addItem),
);

// PATCH /api/v1/cart/items/:productId?variantId=...
router.patch(
  "/items/:productId",
  endpointLimiterMongo({ scope: "cart:setQty", windowMs: 60_000, max: 140, messageCode: "CART_RATE_LIMIT" }),
  idempotencyEnforce({ routeName: "cart:setQty", required: true }),
  validate(updateCartItemQtySchema),
  asyncHandler(setQty),
);

// DELETE /api/v1/cart/items/:productId?variantId=...
router.delete(
  "/items/:productId",
  endpointLimiterMongo({ scope: "cart:remove", windowMs: 60_000, max: 160, messageCode: "CART_RATE_LIMIT" }),
  idempotencyEnforce({ routeName: "cart:remove", required: true }),
  asyncHandler(removeItem),
);

// DELETE /api/v1/cart  (clear)
router.delete(
  "/",
  endpointLimiterMongo({ scope: "cart:clear", windowMs: 60_000, max: 30, messageCode: "CART_RATE_LIMIT" }),
  idempotencyEnforce({ routeName: "cart:clear", required: true }),
  asyncHandler(clearMyCart),
);

export default router;
