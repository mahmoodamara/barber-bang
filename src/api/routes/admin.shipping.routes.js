// src/api/routes/admin.shipping.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

// Validators
import {
  createShippingMethodSchema,
  updateShippingMethodSchema,
} from "../../validators/shipping.validators.js";

// Controllers
import {
  listAdminShippingMethods,
  getAdminShippingMethod,
  createShippingMethod,
  updateShippingMethod,
  deactivateShippingMethod,
} from "../../controllers/adminShipping.controller.js";

const router = Router();

/**
 * This router is mounted at: /api/v1/admin/shipping-methods
 * So paths here must be relative ("/", "/:id") — NOT "/shipping-methods".
 *
 * Important:
 * - requireAuth can be redundant if enforced at admin.routes.js mount,
 *   but keeping it is safe and avoids accidental exposure if mounted elsewhere.
 */
router.use(requireAuth);

// Defense-in-depth: never cache admin responses
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

/**
 * IMPORTANT:
 * If idempotencyEnforce hashes req.body, normalize req.body to validated payload.
 * If your idempotencyEnforce already prefers req.validated.body internally,
 * this is optional (safe to keep).
 */
const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Shipping Methods (Admin)                                            */
/* ------------------------------------------------------------------ */

// Read-only: admin + staff
router.get(
  "/",
  requireAdminOrStaff,
  adminLimit("admin:shipping:list", { max: 300 }),
  asyncHandler(listAdminShippingMethods),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  adminLimit("admin:shipping:get", { max: 300 }),
  asyncHandler(getAdminShippingMethod),
);

// Mutations: admin-only
router.post(
  "/",
  requireAdmin,
  adminLimit("admin:shipping:create", { max: 60 }),
  validate(createShippingMethodSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:shipping:create", required: true }),
  asyncHandler(createShippingMethod),
);

router.patch(
  "/:id",
  requireAdmin,
  adminLimit("admin:shipping:update", { max: 120 }),
  validate(updateShippingMethodSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:shipping:update", required: true }),
  asyncHandler(updateShippingMethod),
);

// Deactivate (soft): admin-only
router.delete(
  "/:id",
  requireAdmin,
  adminLimit("admin:shipping:deactivate", { max: 60 }),
  // no validate here; keep stable body if present (usually empty)
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:shipping:deactivate", required: true }),
  asyncHandler(deactivateShippingMethod),
);

export default router;
