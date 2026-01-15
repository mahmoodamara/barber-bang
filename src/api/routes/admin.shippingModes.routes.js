// src/api/routes/admin.shippingModes.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

// Validators
import {
  createDeliveryAreaSchema,
  updateDeliveryAreaSchema,
  createPickupPointSchema,
  updatePickupPointSchema,
  updateStorePickupConfigSchema,
} from "../../validators/shippingMode.validators.js";

// Controllers
import {
  listDeliveryAreas,
  getDeliveryArea,
  createDeliveryArea,
  updateDeliveryArea,
  deactivateDeliveryArea,
} from "../../controllers/adminDeliveryAreas.controller.js";

import {
  listPickupPoints,
  getPickupPoint,
  createPickupPoint,
  updatePickupPoint,
  deactivatePickupPoint,
} from "../../controllers/adminPickupPoints.controller.js";

import {
  getStorePickupConfig,
  updateStorePickupConfig,
} from "../../controllers/adminStorePickup.controller.js";

const router = Router();

router.use(requireAuth);

// Defense-in-depth: never cache admin responses
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdmin = requireRoleAny([UserRoles.ADMIN]);
const requireAdminOrStaff = requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF]);

const adminLimit = (scope, { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {}) =>
  endpointLimiterMongo({ scope, windowMs, max, messageCode });

const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Delivery Areas                                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/areas",
  requireAdminOrStaff,
  adminLimit("admin:areas:list", { max: 300 }),
  asyncHandler(listDeliveryAreas),
);

router.get(
  "/areas/:id",
  requireAdminOrStaff,
  adminLimit("admin:areas:get", { max: 300 }),
  asyncHandler(getDeliveryArea),
);

router.post(
  "/areas",
  requireAdmin,
  adminLimit("admin:areas:create", { max: 60 }),
  validate(createDeliveryAreaSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:areas:create", required: true }),
  asyncHandler(createDeliveryArea),
);

router.patch(
  "/areas/:id",
  requireAdmin,
  adminLimit("admin:areas:update", { max: 120 }),
  validate(updateDeliveryAreaSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:areas:update", required: true }),
  asyncHandler(updateDeliveryArea),
);

router.delete(
  "/areas/:id",
  requireAdmin,
  adminLimit("admin:areas:deactivate", { max: 60 }),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:areas:deactivate", required: true }),
  asyncHandler(deactivateDeliveryArea),
);

/* ------------------------------------------------------------------ */
/* Pickup Points                                                       */
/* ------------------------------------------------------------------ */

router.get(
  "/pickup-points",
  requireAdminOrStaff,
  adminLimit("admin:pickup-points:list", { max: 300 }),
  asyncHandler(listPickupPoints),
);

router.get(
  "/pickup-points/:id",
  requireAdminOrStaff,
  adminLimit("admin:pickup-points:get", { max: 300 }),
  asyncHandler(getPickupPoint),
);

router.post(
  "/pickup-points",
  requireAdmin,
  adminLimit("admin:pickup-points:create", { max: 60 }),
  validate(createPickupPointSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:pickup-points:create", required: true }),
  asyncHandler(createPickupPoint),
);

router.patch(
  "/pickup-points/:id",
  requireAdmin,
  adminLimit("admin:pickup-points:update", { max: 120 }),
  validate(updatePickupPointSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:pickup-points:update", required: true }),
  asyncHandler(updatePickupPoint),
);

router.delete(
  "/pickup-points/:id",
  requireAdmin,
  adminLimit("admin:pickup-points:deactivate", { max: 60 }),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:pickup-points:deactivate", required: true }),
  asyncHandler(deactivatePickupPoint),
);

/* ------------------------------------------------------------------ */
/* Store Pickup Config (singleton)                                     */
/* ------------------------------------------------------------------ */

router.get(
  "/store-pickup",
  requireAdminOrStaff,
  adminLimit("admin:store-pickup:get", { max: 300 }),
  asyncHandler(getStorePickupConfig),
);

router.patch(
  "/store-pickup",
  requireAdmin,
  adminLimit("admin:store-pickup:update", { max: 60 }),
  validate(updateStorePickupConfigSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:store-pickup:update", required: true }),
  asyncHandler(updateStorePickupConfig),
);

export default router;
