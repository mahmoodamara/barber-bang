// src/api/routes/admin.orders.routes.js
import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requirePermissionAny, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminAddOrderNoteSchema,
  adminListOrdersQuerySchema,
  adminOrderIdParamsSchema,
  adminResolvePaymentSchema,
  adminUpdateOrderStatusSchema,
  adminUpdateOrderTrackingSchema,
} from "../../validators/adminOrders.validators.js";

import {
  adminGetOrder,
  adminListOrders,
  adminAddOrderNote,
  adminResolvePayment,
  adminUpdateOrderStatus,
  adminUpdateOrderTracking,
} from "../../controllers/adminOrders.controller.js";

import { adminAddFulfillmentEvent } from "../../controllers/fulfillment.controller.js";
import { adminAddFulfillmentEventSchema } from "../../validators/fulfillment.validators.js";

import { adminRefundSchema } from "../../validators/refund.validators.js";
import { adminRefund } from "../../controllers/adminOps.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/orders
 * Defense-in-depth: requireAuth + no-store, even if mounted under admin.routes.js.
 */
router.use(requireAuth);

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdmin = requireRoleAny([UserRoles.ADMIN]);
const requireAdminOrStaff = requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF]);

const adminLimit = (
  scope,
  { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {},
) => endpointLimiterMongo({ scope, windowMs, max, messageCode });

const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Orders (Admin)                                                     */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdminOrStaff,
  requirePermissionAny(["orders.read"]),
  adminLimit("admin:orders:list", { max: 180 }),
  validate(adminListOrdersQuerySchema),
  asyncHandler(adminListOrders),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  requirePermissionAny(["orders.read"]),
  adminLimit("admin:orders:get", { max: 240 }),
  validate(adminOrderIdParamsSchema),
  asyncHandler(adminGetOrder),
);

router.patch(
  "/:id/status",
  requireAdminOrStaff,
  requirePermissionAny(["orders.update_status"]),
  adminLimit("admin:orders:status_update", { max: 60 }),
  validate(adminUpdateOrderStatusSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:orders:status_update", required: true }),
  asyncHandler(adminUpdateOrderStatus),
);

router.patch(
  "/:id/tracking",
  requireAdminOrStaff,
  requirePermissionAny(["orders.update_tracking"]),
  adminLimit("admin:orders:tracking_update", { max: 120 }),
  validate(adminUpdateOrderTrackingSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:orders:tracking_update", required: true }),
  asyncHandler(adminUpdateOrderTracking),
);

router.post(
  "/:id/notes",
  requireAdminOrStaff,
  requirePermissionAny(["orders.notes.write"]),
  adminLimit("admin:orders:note_add", { max: 120 }),
  validate(adminAddOrderNoteSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:orders:note_add", required: true }),
  asyncHandler(adminAddOrderNote),
);

router.post(
  "/:id/payment/resolve",
  requireAdmin,
  requirePermissionAny(["orders.payment.resolve"]),
  adminLimit("admin:orders:payment_resolve", { max: 60 }),
  validate(adminResolvePaymentSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:orders:payment_resolve", required: true }),
  asyncHandler(adminResolvePayment),
);

router.post(
  "/:id/fulfillment/events",
  requireAdminOrStaff,
  requirePermissionAny(["orders.fulfillment.write"]),
  adminLimit("admin:orders:fulfillment_event_add", { max: 120 }),
  validate(adminAddFulfillmentEventSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:orders:fulfillment_event_add", required: true }),
  asyncHandler(adminAddFulfillmentEvent),
);

// Refund: permission-gated (grant orders.refund explicitly)
router.post(
  "/:id/refund",
  requireAdminOrStaff,
  requirePermissionAny(["orders.refund"]),
  adminLimit("admin:refund", { max: 10 }),
  validate(adminRefundSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:refund", required: true }),
  asyncHandler(adminRefund),
);

export default router;
