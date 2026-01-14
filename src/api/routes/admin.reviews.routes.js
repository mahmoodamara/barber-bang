// src/api/routes/admin.reviews.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminListReviewsQuerySchema,
  adminApproveReviewParamsSchema,
  adminRejectSchema,
} from "../../validators/review.validators.js";

import {
  adminListReviews,
  adminApproveReview,
  adminRejectReview,
} from "../../controllers/adminReviews.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/reviews
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
 * Idempotency hashing stability (optional if your idempotencyEnforce already prefers req.validated.body)
 */
const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Reviews moderation (Admin)                                          */
/* ------------------------------------------------------------------ */

// List: allow staff/admin (read-only)
router.get(
  "/",
  requireAdminOrStaff,
  adminLimit("admin:reviews:list", { max: 120 }),
  validate(adminListReviewsQuerySchema),
  asyncHandler(adminListReviews),
);

/**
 * Approve / Reject:
 * Recommendation: ADMIN-only for moderation actions (safer default).
 * If you want STAFF to moderate too, change requireAdmin -> requireAdminOrStaff.
 */

// Approve: admin-only
router.post(
  "/:id/approve",
  requireAdmin,
  adminLimit("admin:reviews:approve", { max: 60 }),
  validate(adminApproveReviewParamsSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:reviews:approve", required: true }),
  asyncHandler(adminApproveReview),
);

// Reject: admin-only (has body: reason)
router.post(
  "/:id/reject",
  requireAdmin,
  adminLimit("admin:reviews:reject", { max: 60 }),
  validate(adminRejectSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:reviews:reject", required: true }),
  asyncHandler(adminRejectReview),
);

export default router;
