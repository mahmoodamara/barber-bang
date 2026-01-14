// src/api/routes/admin.promotions.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

import {
  adminPromotionIdParamsSchema,
  adminPromotionPreviewSchema,
  createPromotionSchema,
  updatePromotionSchema,
} from "../../validators/promotion.validators.js";

import {
  createPromotion,
  getPromotion,
  listPromotions,
  previewPromotion,
  updatePromotion,
} from "../../controllers/adminPromotions.controller.js";

const router = Router();

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
/* Promotions (Admin)                                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/",
  requireAdminOrStaff,
  adminLimit("admin:promotions:list", { max: 300 }),
  asyncHandler(listPromotions),
);

router.get(
  "/:id",
  requireAdminOrStaff,
  adminLimit("admin:promotions:get", { max: 300 }),
  validate(adminPromotionIdParamsSchema),
  asyncHandler(getPromotion),
);

router.post(
  "/",
  requireAdmin,
  adminLimit("admin:promotions:create", { max: 60 }),
  validate(createPromotionSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:promotions:create", required: true }),
  asyncHandler(createPromotion),
);

router.patch(
  "/:id",
  requireAdmin,
  adminLimit("admin:promotions:update", { max: 120 }),
  validate(updatePromotionSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:promotions:update", required: true }),
  asyncHandler(updatePromotion),
);

router.post(
  "/:id/preview",
  requireAdminOrStaff,
  adminLimit("admin:promotions:preview", { max: 120 }),
  validate(adminPromotionPreviewSchema),
  asyncHandler(previewPromotion),
);

export default router;
