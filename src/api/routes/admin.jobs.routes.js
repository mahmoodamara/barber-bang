// src/api/routes/admin.jobs.routes.js
import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requirePermissionAny, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminJobIdParamsSchema,
  adminListJobsQuerySchema,
  adminRetryFailedJobsSchema,
  adminRetryJobSchema,
} from "../../validators/adminJobs.validators.js";

import {
  adminGetJob,
  adminListJobs,
  adminRetryFailedJobs,
  adminRetryJob,
} from "../../controllers/adminJobs.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/jobs
 * Defense-in-depth: requireAuth + no-store, even if mounted under admin.routes.js.
 */
router.use(requireAuth);

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

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
/* Jobs (Admin)                                                       */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdminOrStaff,
  requirePermissionAny(["jobs.read"]),
  adminLimit("admin:jobs:list", { max: 180 }),
  validate(adminListJobsQuerySchema),
  asyncHandler(adminListJobs),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  requirePermissionAny(["jobs.read"]),
  adminLimit("admin:jobs:get", { max: 240 }),
  validate(adminJobIdParamsSchema),
  asyncHandler(adminGetJob),
);

router.post(
  "/:id/retry",
  requireAdminOrStaff,
  requirePermissionAny(["jobs.retry"]),
  adminLimit("admin:jobs:retry", { max: 60 }),
  validate(adminRetryJobSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:jobs:retry", required: true }),
  asyncHandler(adminRetryJob),
);

router.post(
  "/retry-failed",
  requireAdminOrStaff,
  requirePermissionAny(["jobs.retry"]),
  adminLimit("admin:jobs:retry_failed", { max: 10 }),
  validate(adminRetryFailedJobsSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:jobs:retry_failed", required: true }),
  asyncHandler(adminRetryFailedJobs),
);

export default router;
