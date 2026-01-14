// src/api/routes/index.js
import { Router } from "express";

import authRoutes from "./auth.routes.js";
import catalogRoutes from "./catalog.routes.js";
import adminRoutes from "./admin.routes.js";
import ordersRoutes from "./orders.routes.js";
import returnsRoutes from "./returns.routes.js";
import wishlistRoutes from "./wishlist.routes.js";
import reviewsRoutes from "./reviews.routes.js";
import shippingRoutes from "./shipping.routes.js";
import addressesRoutes from "./addresses.routes.js";
import cartRoutes from "./cart.routes.js";

export const apiRouter = Router();

/**
 * Lightweight meta endpoints (safe, cacheable)
 * - Useful for load balancers, monitoring, and quick sanity checks
 */
apiRouter.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "barber-store-api",
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get("/version", (req, res) => {
  res.status(200).json({
    ok: true,
    // Optional: wire these env vars in CI
    version: process.env.APP_VERSION || "dev",
    commit: process.env.GIT_SHA || null,
  });
});

/* ------------------------------------------------------------------ */
/* Public/Auth                                                         */
/* ------------------------------------------------------------------ */
apiRouter.use("/auth", authRoutes);
apiRouter.use("/catalog", catalogRoutes);
apiRouter.use("/shipping", shippingRoutes);

/* ------------------------------------------------------------------ */
/* Auth required (internally enforced in each router)                  */
/* ------------------------------------------------------------------ */
apiRouter.use("/orders", ordersRoutes);
apiRouter.use("/returns", returnsRoutes);
apiRouter.use("/wishlist", wishlistRoutes);
apiRouter.use("/cart", cartRoutes);
apiRouter.use("/addresses", addressesRoutes);

/* ------------------------------------------------------------------ */
/* Public + Auth mixed (depends on routes)                             */
/* ------------------------------------------------------------------ */
apiRouter.use("/reviews", reviewsRoutes);

/* ------------------------------------------------------------------ */
/* Admin only (internally enforced in admin router)                    */
/* ------------------------------------------------------------------ */
apiRouter.use("/admin", adminRoutes);

/**
 * API-only 404 (prevents express default HTML for unknown API routes)
 * - Keep it LAST
 */
apiRouter.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "API route not found",
      requestId: req.requestId || req.id || null,
      path: req.originalUrl,
    },
  });
});
