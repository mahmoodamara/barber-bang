// src/api/routes/admin.featureFlags.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

// Validators
import {
  adminListFeatureFlagsSchema,
  adminUpsertFeatureFlagSchema,
  adminDeleteFeatureFlagSchema,
} from "../../validators/featureFlags.validators.js";

// Controllers
import {
  listFeatureFlags,
  upsertFeatureFlag,
  deleteFeatureFlag,
} from "../../controllers/adminFeatureFlags.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/feature-flags
 */
router.use(requireAuth);

// Defense-in-depth: never cache admin responses
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Feature flags should be ADMIN-only (safest default)
const requireAdmin = requireRoleAny([UserRoles.ADMIN]);

const adminLimit = (
  scope,
  { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {},
) => endpointLimiterMongo({ scope, windowMs, max, messageCode });

/**
 * Idempotency hashing stability (optional if idempotencyEnforce already prefers req.validated.body)
 */
const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Feature Flags (Admin)                                               */
/* ------------------------------------------------------------------ */

// List: admin-only
router.get(
  "/",
  requireAdmin,
  adminLimit("admin:flags:list", { max: 120 }),
  validate(adminListFeatureFlagsSchema),
  asyncHandler(listFeatureFlags),
);

// Upsert: admin-only (validate before idempotency for stable hashing)
router.put(
  "/:key",
  requireAdmin,
  adminLimit("admin:flags:upsert", { max: 60 }),
  validate(adminUpsertFeatureFlagSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:flags:upsert", required: true }),
  asyncHandler(upsertFeatureFlag),
);

// Delete: admin-only
router.delete(
  "/:key",
  requireAdmin,
  adminLimit("admin:flags:delete", { max: 30 }),
  validate(adminDeleteFeatureFlagSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:flags:delete", required: true }),
  asyncHandler(deleteFeatureFlag),
);

export default router;
