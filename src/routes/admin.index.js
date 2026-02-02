// src/routes/admin.index.js
// Single combined admin router: auth -> permission -> rateLimit (app-level) -> audit (with before-state).
// Mount at /api/admin (and optionally /api/v1/admin for backward compatibility).

import express from "express";
import adminReturnsRoutes from "./admin.returns.routes.js";
import adminOrdersRoutes from "./admin.orders.routes.js";
import adminAuditRoutes from "./admin.audit.routes.js";
import adminUsersRoutes from "./admin.users.routes.js";
import adminContentRoutes from "./admin.content.routes.js";
import adminSettingsRoutes from "./admin.settings.routes.js";
import adminHomeLayoutRoutes from "./admin.home-layout.routes.js";
import adminMediaRoutes from "./admin.media.routes.js";
import adminProductAttributesRoutes from "./admin.product-attributes.routes.js";
import adminReviewsRoutes from "./admin.reviews.routes.js";
import adminDashboardRoutes from "./admin.dashboard.routes.js";
import adminCategoriesRoutes from "./admin.categories.routes.js";
import adminStockReservationsRoutes from "./admin.stock-reservations.routes.js";
import adminProductsRoutes from "./admin.products.routes.js";
import adminApprovalsRoutes from "./admin.approvals.routes.js";
import adminRoutes from "./admin.routes.js";

const router = express.Router();

router.use("/returns", adminReturnsRoutes);
router.use("/orders", adminOrdersRoutes);
router.use("/audit-logs", adminAuditRoutes);
router.use("/users", adminUsersRoutes);
router.use("/content", adminContentRoutes);
router.use("/settings", adminSettingsRoutes);
router.use("/home-layout", adminHomeLayoutRoutes);
router.use("/media", adminMediaRoutes);
router.use("/product-attributes", adminProductAttributesRoutes);
router.use("/reviews", adminReviewsRoutes);
router.use("/dashboard", adminDashboardRoutes);
router.use("/categories", adminCategoriesRoutes);
router.use("/stock-reservations", adminStockReservationsRoutes);
router.use("/products", adminProductsRoutes);
router.use("/approvals", adminApprovalsRoutes);
router.use("/", adminRoutes);

export default router;
