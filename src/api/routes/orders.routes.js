// src/api/routes/orders.routes.js
import { Router } from "express";

import { requireAuth } from "../../middlewares/auth.js";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { attachShippingMethodCode } from "../../middlewares/attachShippingMethodCode.js";
import {
  createOrderSchema,
  checkoutSchema,
  orderQuoteSchema,
  updateOrderAddressSchema,
} from "../../validators/order.validators.js";
import { setOrderShippingMethodSchema } from "../../validators/shipping.validators.js";

// Phase 6
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

// Orders
import {
  createOrder,
  createCheckout,
  getOrderQuote,
  getMyOrders,
  getOrder,
  cancelOrder,
  patchOrderAddress,
} from "../../controllers/orders.controller.js";
import { cancelOrderSchema } from "../../validators/cancel.validators.js";

// Phase 8 (Coupons on Order)
import { applyCoupon, removeCoupon } from "../../controllers/orderCoupons.controller.js";
import { applyCouponSchema } from "../../validators/coupon.validators.js";
import { listForOrder, setForOrder } from "../../controllers/orderShipping.controller.js";
import { getFulfillmentTimeline } from "../../controllers/fulfillment.controller.js";
import { myOrderFulfillmentParamsSchema } from "../../validators/fulfillment.validators.js";

const router = Router();

router.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Orders                                                             */
/* ------------------------------------------------------------------ */

// Create order (idempotent: prevents duplicate draft/orders on retry)
router.post(
  "/",
  endpointLimiterMongo({
    scope: "orders:create",
    windowMs: 60_000,
    max: 30,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:create", required: true }),
  validate(createOrderSchema),
  asyncHandler(createOrder),
);

// Quote endpoint: frontend gets shipping options + totals from backend only
router.get(
  "/:id/quote",
  endpointLimiterMongo({
    scope: "orders:quote",
    windowMs: 60_000,
    max: 120,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  validate(orderQuoteSchema),
  asyncHandler(getOrderQuote),
);

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

// Create checkout session (Stripe) — MUST be idempotent
router.post(
  "/:id/checkout",
  endpointLimiterMongo({
    scope: "checkout:create",
    windowMs: 60_000,
    max: 10,
    messageCode: "CHECKOUT_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:checkout", required: true }),
  validate(checkoutSchema),
  asyncHandler(createCheckout),
);

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

router.post(
  "/:id/cancel",
  endpointLimiterMongo({
    scope: "orders:cancel",
    windowMs: 60_000,
    max: 10,
    messageCode: "CANCEL_RATE_LIMIT",
  }),
  // Cancel should be idempotent too (client retries / double-click)
  idempotencyEnforce({ routeName: "orders:cancel", required: true }),
  validate(cancelOrderSchema),
  asyncHandler(cancelOrder),
);

/* ------------------------------------------------------------------ */
/* Phase 8: Coupons                                                    */
/* ------------------------------------------------------------------ */

// Apply coupon (idempotent to avoid double reserve / usesTotal drift on retries)
router.post(
  "/:id/coupon",
  endpointLimiterMongo({
    scope: "orders:coupon:apply",
    windowMs: 10_000,
    max: 20,
    messageCode: "COUPON_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:coupon:apply", required: true }),
  validate(applyCouponSchema),
  asyncHandler(applyCoupon),
);

// Remove coupon (idempotent as well)
router.delete(
  "/:id/coupon",
  endpointLimiterMongo({
    scope: "orders:coupon:remove",
    windowMs: 10_000,
    max: 20,
    messageCode: "COUPON_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:coupon:remove", required: true }),
  asyncHandler(removeCoupon),
);

/* ------------------------------------------------------------------ */
/* Phase 11: Shipping                                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/:id/shipping/methods",
  endpointLimiterMongo({
    scope: "orders:shipping:methods",
    windowMs: 60_000,
    max: 120,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  asyncHandler(listForOrder),
);

router.post(
  "/:id/shipping",
  endpointLimiterMongo({
    scope: "orders:shipping:set",
    windowMs: 60_000,
    max: 60,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:shipping:set", required: true }),
  attachShippingMethodCode,
  validate(setOrderShippingMethodSchema),
  asyncHandler(setForOrder),
);

/* ------------------------------------------------------------------ */
/* Address (Order)                                                     */
/* ------------------------------------------------------------------ */

router.patch(
  "/:id/address",
  endpointLimiterMongo({
    scope: "orders:address:patch",
    windowMs: 60_000,
    max: 120,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  idempotencyEnforce({ routeName: "orders:address:patch", required: true }),
  validate(updateOrderAddressSchema),
  asyncHandler(patchOrderAddress),
);

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  endpointLimiterMongo({
    scope: "orders:list",
    windowMs: 60_000,
    max: 120,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  asyncHandler(getMyOrders),
);

router.get(
  "/:id",
  endpointLimiterMongo({
    scope: "orders:get",
    windowMs: 60_000,
    max: 180,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  asyncHandler(getOrder),
);

router.get(
  "/:id/fulfillment",
  endpointLimiterMongo({
    scope: "orders:fulfillment:get",
    windowMs: 60_000,
    max: 240,
    messageCode: "ORDERS_RATE_LIMIT",
  }),
  validate(myOrderFulfillmentParamsSchema),
  asyncHandler(getFulfillmentTimeline),
);

export default router;
