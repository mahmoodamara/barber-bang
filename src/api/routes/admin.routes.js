// src/api/routes/admin.routes.js
import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth, requireRoleAny } from "../../middlewares/auth.js";
import { UserRoles } from "../../models/User.js";

// Distributed limiter + idempotency
import { endpointLimiterMongo } from "../../middlewares/endpointLimiterMongo.js";
import { idempotencyEnforce } from "../../middlewares/idempotencyEnforce.js";

// Validators (catalog)
import {
  createCategorySchema,
  updateCategorySchema,
} from "../../validators/category.validators.js";
import {
  createProductSchema,
  updateProductSchema,
} from "../../validators/product.validators.js";
import {
  createVariantSchema,
  updateVariantSchema,
  adjustStockSchema,
} from "../../validators/variant.validators.js";

// Validators (Coupons)
import {
  createCouponSchema,
  updateCouponSchema,
} from "../../validators/coupon.validators.js";

// Controllers (catalog)
import {
  createCategory,
  updateCategory,
  softDeleteCategory,
  adminListCategories,
  createProduct,
  updateProduct,
  softDeleteProduct,
  createVariant,
  updateVariant,
  softDeleteVariant,
  adjustVariantStock,
} from "../../controllers/admin.controller.js";

// Ops controllers
import { opsSummary } from "../../controllers/adminOps.controller.js";

// Coupons controllers
import {
  createCoupon,
  listCoupons,
  getCoupon,
  updateCoupon,
  deactivateCoupon,
} from "../../controllers/adminCoupons.controller.js";

// Sub-routers
import adminShippingRouter from "./admin.shipping.routes.js";
import adminReviewsRouter from "./admin.reviews.routes.js";
import adminFeatureFlagsRouter from "./admin.featureFlags.routes.js";
import adminReadModelsRouter from "./admin.readModels.routes.js";
import adminAuditLogsRouter from "./admin.auditLogs.routes.js";
import adminUsersRouter from "./admin.users.routes.js";
import adminOrdersRouter from "./admin.orders.routes.js";
import adminJobsRouter from "./admin.jobs.routes.js";
import adminReturnsRouter from "./admin.returns.routes.js";
import adminPromotionsRouter from "./admin.promotions.routes.js";

const router = Router();

/**
 * Admin hardening:
 * - requireAuth globally
 * - RBAC enforced per endpoint and (now) also safely on sub-router mounts
 */
router.use(requireAuth);

// Defense-in-depth: admin responses should never be cached
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const requireAdmin = requireRoleAny([UserRoles.ADMIN]);
const requireAdminOrStaff = requireRoleAny([UserRoles.ADMIN, UserRoles.STAFF]);

// Helper: consistent admin limiter defaults
const adminLimit = (
  scope,
  { windowMs = 60_000, max, messageCode = "ADMIN_RATE_LIMIT" } = {},
) => endpointLimiterMongo({ scope, windowMs, max, messageCode });

/**
 * IMPORTANT:
 * Some idempotency implementations hash req.body.
 * Our validate(...) convention uses req.validated.body.
 * To ensure stable hashing, we optionally normalize req.body to the validated payload.
 *
 * Note:
 * If your idempotencyEnforce already prefers req.validated.body internally,
 * this middleware becomes optional (safe to keep).
 */
const useValidatedBodyForIdempotency = (req, _res, next) => {
  const vb = req?.validated?.body;
  if (vb && typeof vb === "object" && !Array.isArray(vb)) {
    req.body = vb;
  }
  next();
};

/* ------------------------------------------------------------------ */
/* Mount sub-routers (with safe RBAC at mount)                         */
/* ------------------------------------------------------------------ */

/**
 * Shipping methods
 * - Allow staff/admin access to router (read endpoints can be staff)
 * - Mutations must still be admin-only inside admin.shipping.routes.js
 */
router.use(
  "/shipping-methods",
  requireAdminOrStaff,
  adminLimit("admin:shipping:router", { max: 600 }),
  adminShippingRouter,
);

/**
 * Reviews moderation
 * - Allow staff/admin access to router
 * - Approve/reject policy should be enforced inside router (recommended admin-only)
 */
router.use(
  "/reviews",
  requireAdminOrStaff,
  adminLimit("admin:reviews:router", { max: 600 }),
  adminReviewsRouter,
);

/**
 * Feature flags
 * - Admin-only
 */
router.use(
  "/feature-flags",
  requireAdmin,
  adminLimit("admin:flags:router", { max: 300 }),
  adminFeatureFlagsRouter,
);

/**
 * Read models
 * - Allow staff/admin read
 * - Mutations/refresh can be admin-only inside router if desired
 */
router.use(
  "/read-models",
  requireAdminOrStaff,
  adminLimit("admin:readModels:router", { max: 600 }),
  adminReadModelsRouter,
);

/**
 * Audit logs
 * - Admin-only (safest default)
 */
router.use(
  "/audit-logs",
  requireAdmin,
  adminLimit("admin:auditLogs:router", { max: 300 }),
  adminAuditLogsRouter,
);

/**
 * Users
 * - Allow staff/admin read access
 * - Mutations are enforced inside router (admin-only)
 */
router.use(
  "/users",
  requireAdminOrStaff,
  adminLimit("admin:users:router", { max: 600 }),
  adminUsersRouter,
);

/**
 * Orders
 * - Allow staff/admin access
 * - Refund remains admin-only inside router
 */
router.use(
  "/orders",
  requireAdminOrStaff,
  adminLimit("admin:orders:router", { max: 600 }),
  adminOrdersRouter,
);

/**
 * Returns / RMA
 * - Allow staff/admin access
 */
router.use(
  "/returns",
  requireAdminOrStaff,
  adminLimit("admin:returns:router", { max: 600 }),
  adminReturnsRouter,
);

/**
 * Jobs
 * - Allow staff/admin access
 */
router.use(
  "/jobs",
  requireAdminOrStaff,
  adminLimit("admin:jobs:router", { max: 600 }),
  adminJobsRouter,
);

/**
 * Promotions
 * - Allow staff/admin access
 */
router.use(
  "/promotions",
  requireAdminOrStaff,
  adminLimit("admin:promotions:router", { max: 600 }),
  adminPromotionsRouter,
);

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */
// Read-only: allow staff
router.get(
  "/categories",
  requireAdminOrStaff,
  adminLimit("admin:categories:list", { max: 300 }),
  asyncHandler(adminListCategories),
);

// Mutations: admin-only
router.post(
  "/categories",
  requireAdmin,
  adminLimit("admin:categories:create", { max: 120 }),
  validate(createCategorySchema),
  asyncHandler(createCategory),
);

router.patch(
  "/categories/:id",
  requireAdmin,
  adminLimit("admin:categories:update", { max: 180 }),
  validate(updateCategorySchema),
  asyncHandler(updateCategory),
);

router.delete(
  "/categories/:id",
  requireAdmin,
  adminLimit("admin:categories:delete", { max: 120 }),
  asyncHandler(softDeleteCategory),
);

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */
// Mutations: admin-only
router.post(
  "/products",
  requireAdmin,
  adminLimit("admin:products:create", { max: 120 }),
  validate(createProductSchema),
  asyncHandler(createProduct),
);

router.patch(
  "/products/:id",
  requireAdmin,
  adminLimit("admin:products:update", { max: 180 }),
  validate(updateProductSchema),
  asyncHandler(updateProduct),
);

router.delete(
  "/products/:id",
  requireAdmin,
  adminLimit("admin:products:delete", { max: 120 }),
  asyncHandler(softDeleteProduct),
);

/* ------------------------------------------------------------------ */
/* Variants                                                            */
/* ------------------------------------------------------------------ */
// Mutations: admin-only
router.post(
  "/products/:productId/variants",
  requireAdmin,
  adminLimit("admin:variants:create", { max: 180 }),
  validate(createVariantSchema),
  asyncHandler(createVariant),
);

router.patch(
  "/variants/:id",
  requireAdmin,
  adminLimit("admin:variants:update", { max: 240 }),
  validate(updateVariantSchema),
  asyncHandler(updateVariant),
);

router.delete(
  "/variants/:id",
  requireAdmin,
  adminLimit("admin:variants:delete", { max: 180 }),
  asyncHandler(softDeleteVariant),
);

router.post(
  "/variants/:id/stock-adjust",
  requireAdmin,
  adminLimit("admin:variants:stock_adjust", { max: 120 }),
  validate(adjustStockSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:variants:stock_adjust", required: true }),
  asyncHandler(adjustVariantStock),
);

/* ------------------------------------------------------------------ */
/* Coupons (Admin CRUD)                                                */
/* ------------------------------------------------------------------ */
// Read-only: allow staff
router.get(
  "/coupons",
  requireAdminOrStaff,
  adminLimit("admin:coupons:list", { max: 300 }),
  asyncHandler(listCoupons),
);

router.get(
  "/coupons/:id",
  requireAdminOrStaff,
  adminLimit("admin:coupons:get", { max: 300 }),
  asyncHandler(getCoupon),
);

// Mutations: admin-only
router.post(
  "/coupons",
  requireAdmin,
  adminLimit("admin:coupons:create", { max: 60 }),
  validate(createCouponSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:coupons:create", required: true }),
  asyncHandler(createCoupon),
);

router.patch(
  "/coupons/:id",
  requireAdmin,
  adminLimit("admin:coupons:update", { max: 120 }),
  validate(updateCouponSchema),
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:coupons:update", required: true }),
  asyncHandler(updateCoupon),
);

router.delete(
  "/coupons/:id",
  requireAdmin,
  adminLimit("admin:coupons:deactivate", { max: 60 }),
  // safe even without validate
  useValidatedBodyForIdempotency,
  idempotencyEnforce({ routeName: "admin:coupons:deactivate", required: true }),
  asyncHandler(deactivateCoupon),
);

/* ------------------------------------------------------------------ */
/* Admin Ops                                                           */
/* - Ops Summary                                                       */
/* ------------------------------------------------------------------ */
// Read-only ops: allow staff
router.get(
  "/ops/summary",
  requireAdminOrStaff,
  adminLimit("admin:ops:summary", { max: 120 }),
  asyncHandler(opsSummary),
);

export default router;
