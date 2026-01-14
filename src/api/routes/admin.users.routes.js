// src/api/routes/admin.users.routes.js
import { Router } from "express";

import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requirePermissionAny, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminListUsersQuerySchema,
  adminResetUserPasswordSchema,
  adminUpdateUserSchema,
  adminUserIdParamsSchema,
} from "../../validators/adminUsers.validators.js";

import {
  adminGetUser,
  adminListUsers,
  adminResetUserPassword,
  adminUpdateUser,
} from "../../controllers/adminUsers.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/users
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
/* Users (Admin)                                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdminOrStaff,
  requirePermissionAny(["users.read"]),
  adminLimit("admin:users:list", { max: 240 }),
  validate(adminListUsersQuerySchema),
  asyncHandler(adminListUsers),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  requirePermissionAny(["users.read"]),
  adminLimit("admin:users:get", { max: 300 }),
  validate(adminUserIdParamsSchema),
  asyncHandler(adminGetUser),
);

router.patch(
  "/:id",
  requireAdminOrStaff,
  requirePermissionAny(["users.write"]),
  adminLimit("admin:users:update", { max: 120 }),
  validate(adminUpdateUserSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:users:update", required: true }),
  asyncHandler(adminUpdateUser),
);

router.post(
  "/:id/reset-password",
  requireAdminOrStaff,
  requirePermissionAny(["users.reset_password"]),
  adminLimit("admin:users:reset_password", { max: 30 }),
  validate(adminResetUserPasswordSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:users:reset_password", required: true }),
  asyncHandler(adminResetUserPassword),
);

export default router;
