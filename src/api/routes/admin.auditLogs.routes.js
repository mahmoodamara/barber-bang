// src/api/routes/admin.auditLogs.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";

import { adminListAuditLogsQuerySchema } from "../../validators/auditLog.validators.js";
import { listAuditLogs } from "../../controllers/adminAuditLogs.controller.js";

const router = Router();

/**
 * Mounted at: /api/v1/admin/audit-logs
 */
router.use(requireAuth);

// Defense-in-depth: never cache admin responses
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdmin = requireRoleAny([UserRoles.ADMIN]);

const adminLimit = (
  scope,
  { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {},
) => endpointLimiterMongo({ scope, windowMs, max, messageCode });

/* ------------------------------------------------------------------ */
/* Audit Logs (Admin)                                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdmin,
  adminLimit("admin:auditLogs:list", { max: 120 }),
  validate(adminListAuditLogsQuerySchema),
  asyncHandler(listAuditLogs),
);

export default router;
