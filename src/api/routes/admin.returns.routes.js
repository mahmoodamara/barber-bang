import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requirePermissionAny, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminListReturns,
  adminGetReturn,
  adminDecision,
  adminMarkReceived,
  adminClose,
} from "../../controllers/adminReturns.controller.js";

import {
  adminListReturnsQuerySchema,
  adminReturnIdParamsSchema,
  adminDecisionSchema,
  adminMarkReceivedSchema,
  adminCloseSchema,
} from "../../validators/return.validators.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/returns
 * Defense-in-depth: requireAuth + no-store, even if mounted under admin.routes.js.
 */
router.use(requireAuth);

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdminOrStaff = requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF]);

const adminLimit = (scope, { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {}) =>
  endpointLimiterMongo({ scope, windowMs, max, messageCode });

const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) req.body = vb;
  next();
};

/* ------------------------------------------------------------------ */
/* Returns (Admin)                                                    */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdminOrStaff,
  requirePermissionAny(["returns.read"]),
  adminLimit("admin:returns:list", { max: 240 }),
  validate(adminListReturnsQuerySchema),
  asyncHandler(adminListReturns),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  requirePermissionAny(["returns.read"]),
  adminLimit("admin:returns:get", { max: 240 }),
  validate(adminReturnIdParamsSchema),
  asyncHandler(adminGetReturn),
);

router.post(
  "/:id/decision",
  requireAdminOrStaff,
  requirePermissionAny(["returns.decide"]),
  adminLimit("admin:returns:decision", { max: 120 }),
  validate(adminDecisionSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:returns:decision", required: true }),
  asyncHandler(adminDecision),
);

router.post(
  "/:id/received",
  requireAdminOrStaff,
  requirePermissionAny(["returns.receive"]),
  adminLimit("admin:returns:received", { max: 120 }),
  validate(adminMarkReceivedSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:returns:received", required: true }),
  asyncHandler(adminMarkReceived),
);

router.post(
  "/:id/close",
  requireAdminOrStaff,
  requirePermissionAny(["returns.close"]),
  adminLimit("admin:returns:close", { max: 120 }),
  validate(adminCloseSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:returns:close", required: true }),
  asyncHandler(adminClose),
);

export default router;
