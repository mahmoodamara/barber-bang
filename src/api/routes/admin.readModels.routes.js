// src/api/routes/admin.readModels.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";

// Validators
import { adminReadModelQuerySchema } from "../../validators/readModels.validators.js";

// Controllers
import {
  getReadModel,
  listReadModels,
  // OPTIONAL (recommended): refresh endpoint if you implement it
  // refreshReadModels,
} from "../../controllers/adminReadModels.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/read-models
 */
router.use(requireAuth);

// Defense-in-depth: never cache admin responses
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdminOrStaff = requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF]);

const adminLimit = (
  scope,
  { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {},
) => endpointLimiterMongo({ scope, windowMs, max, messageCode });

/* ------------------------------------------------------------------ */
/* Read Models (Admin)                                                 */
/* ------------------------------------------------------------------ */

// List: allow staff/admin
router.get(
  "/",
  requireAdminOrStaff,
  adminLimit("admin:readModels:list", { max: 120 }),
  asyncHandler(listReadModels),
);

// Get one: allow staff/admin
router.get(
  "/:key",
  requireAdminOrStaff,
  adminLimit("admin:readModels:get", { max: 120 }),
  validate(adminReadModelQuerySchema),
  asyncHandler(getReadModel),
);

export default router;
