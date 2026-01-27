// src/app.js

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import mongoSanitize from "express-mongo-sanitize";

import { langMiddleware } from "./middleware/lang.js";
import { maintenanceMiddleware } from "./middleware/maintenance.js";
import {
  createLimiter,
  limitAuth,
  limitCheckoutQuote,
  limitCheckoutCreate,
  limitTrackOrder,
  limitAdmin,
} from "./middleware/rateLimit.js";

import authRoutes from "./routes/auth.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import productsRoutes from "./routes/products.routes.js";
import rankingRoutes from "./routes/ranking.routes.js";
import homeRoutes from "./routes/home.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import shippingRoutes from "./routes/shipping.routes.js";
import couponsRoutes from "./routes/coupons.routes.js";
import offersRoutes from "./routes/offers.routes.js";
import checkoutRoutes from "./routes/checkout.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import stripeWebhookRoutes from "./routes/stripe.webhook.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import healthRoutes from "./routes/health.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import adminReturnsRoutes from "./routes/admin.returns.routes.js";
import productAttributesRoutes from "./routes/product-attributes.routes.js";
import adminProductAttributesRoutes from "./routes/admin.product-attributes.routes.js";

// ✅ NEW
import wishlistRoutes from "./routes/wishlist.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import contentRoutes from "./routes/content.routes.js";

// ✅ P0 Admin Modules
import adminProductsRoutes from "./routes/admin.products.routes.js";
import adminOrdersRoutes from "./routes/admin.orders.routes.js";
import adminAuditRoutes from "./routes/admin.audit.routes.js";
import adminUsersRoutes from "./routes/admin.users.routes.js";
import adminContentRoutes from "./routes/admin.content.routes.js";
import adminSettingsRoutes from "./routes/admin.settings.routes.js";
import adminHomeLayoutRoutes from "./routes/admin.home-layout.routes.js";
import adminMediaRoutes from "./routes/admin.media.routes.js";
import adminReviewsRoutes from "./routes/admin.reviews.routes.js"; // ✅ NEW
import adminDashboardRoutes from "./routes/admin.dashboard.routes.js";
import adminCategoriesRoutes from "./routes/admin.categories.routes.js";
import adminStockReservationsRoutes from "./routes/admin.stock-reservations.routes.js";

import { errorHandler, notFound, getRequestId } from "./middleware/error.js";
import { metricsMiddleware, getMetricsSnapshot } from "./middleware/metrics.js";

// ✅ Securing metrics (admin only in production)
import { requireAuth, requireRole } from "./middleware/auth.js";

export const app = express();

const isProd = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
const trustProxyEnv = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
if (["", "0", "false", "off", "no"].includes(trustProxyEnv)) {
  app.set("trust proxy", false);
} else if (["1", "true", "on", "yes"].includes(trustProxyEnv)) {
  app.set("trust proxy", 1);
} else if (/^\d+$/.test(trustProxyEnv)) {
  app.set("trust proxy", Number(trustProxyEnv));
} else {
  app.set("trust proxy", trustProxyEnv);
}
app.use(compression());

/**
 * Request ID (safe for logs; no body/header logging)
 */
app.use((req, res, next) => {
  req.requestId = getRequestId(req);
  res.setHeader("x-request-id", req.requestId);
  next();
});

/**
 * ✅ Normalize response envelope (add success when missing)
 */
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      Object.prototype.hasOwnProperty.call(payload, "ok") &&
      !Object.prototype.hasOwnProperty.call(payload, "success")
    ) {
      return originalJson({ ...payload, success: Boolean(payload.ok) });
    }
    return originalJson(payload);
  };
  next();
});

/**
 * ✅ Helmet defaults
 * Add CSP only in production (below) to avoid breaking dev tools/hot reload.
 */
app.use(
  helmet({
    // Keep defaults; CSP is applied separately in production.
  })
);

/**
 * ✅ CSP (Defense-in-depth) — Production only
 * This reduces XSS impact significantly.
 */
if (isProd) {
  app.use(
    helmet.contentSecurityPolicy({
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],

        // Images: allow https + data (for base64 thumbnails)
        "img-src": ["'self'", "https:", "data:"],

        // Scripts: keep strict (no unsafe-inline). If you ever need Stripe.js on frontend, it’s not served by this API anyway.
        "script-src": ["'self'"],

        // Styles: allow unsafe-inline temporarily (common with Tailwind injected styles in some setups)
        "style-src": ["'self'", "'unsafe-inline'"],

        // API connections
        "connect-src": ["'self'", "https:"],

        // Fonts
        "font-src": ["'self'", "https:", "data:"],
      },
    })
  );
}

/**
 * ✅ CORS
 * Supports comma-separated origins in env:
 * CORS_ORIGIN="https://site.com,http://localhost:5173"
 */
const corsOriginEnv = String(process.env.CORS_ORIGIN || "").trim();
const corsOriginList = corsOriginEnv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const localhostOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
]);

const allowedOrigins = new Set(corsOriginList);
if (!isProd) {
  for (const o of localhostOrigins) allowedOrigins.add(o);
}

const corsConfig = {
  origin: (origin, cb) => {
    // Allow server-to-server / curl / Postman with no origin
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);

    const err = new Error("CORS_NOT_ALLOWED");
    err.statusCode = 403;
    err.code = "CORS_NOT_ALLOWED";
    return cb(err);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "Accept-Language"],
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig), (_req, res) => res.sendStatus(204));

/**
 * ✅ Global rate limit (broad)
 * Specific endpoints also get stricter limits below.
 */
app.use(
  createLimiter({
    windowMs: 60_000,
    limit: 200,
    keyGenerator: (req) => req.ip,
  })
);

if (!isProd) {
  morgan.token("req-id", (req) => req.requestId || "-");
  app.use(morgan(":method :url :status :res[content-length] - :response-time ms :req-id"));
}

/**
 * Legacy /api prefix (backward compatible)
 */
let legacyApiWarned = false;
function legacyApiDeprecation(req, res, next) {
  if (String(req.url || "").startsWith("/v1")) return next();

  res.setHeader("X-API-Deprecated", "true");
  if (!legacyApiWarned) {
    legacyApiWarned = true;
    console.warn("[api] Legacy /api routes are deprecated. Use /api/v1.");
  }
  return next();
}

/**
 * ✅ IMPORTANT:
 * Stripe webhook must receive RAW body for signature verification.
 * This route must be mounted BEFORE express.json() & mongo-sanitize.
 */
app.use("/api", legacyApiDeprecation);
app.use("/api/stripe/webhook", stripeWebhookRoutes);
app.use("/api/v1/stripe/webhook", stripeWebhookRoutes);

/**
 * ✅ Body parsers (after webhook)
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * 🟠 NoSQL Injection defense-in-depth
 * Sanitizes req.body, req.query, req.params from $ and dot operators.
 * Safe because webhook raw parsing already happened above.
 */
app.use(
  mongoSanitize({
    replaceWith: "_",
  })
);

/**
 * ✅ Metrics
 * 🔒 In production: Admin only (requireAuth + requireRole("admin"))
 * ✅ In dev: open (for easy local debugging)
 */
const metricsEnabled = String(process.env.ENABLE_METRICS || "false").toLowerCase() === "true";
if (metricsEnabled) {
  app.use(metricsMiddleware());

  if (isProd) {
    app.get("/api/v1/metrics", requireAuth(), requireRole("admin"), (_req, res) => {
      return res.json({ ok: true, success: true, data: getMetricsSnapshot() });
    });
  } else {
    app.get("/api/v1/metrics", (_req, res) => {
      return res.json({ ok: true, success: true, data: getMetricsSnapshot() });
    });
  }
}

/**
 * ✅ Health endpoints
 * Keep both /health + /api/v1/health/* for Render monitors
 */
app.get("/health", (_req, res) => {
  res.json({ ok: true, success: true, data: { service: "simple-shop-v2" } });
});

app.use("/api/v1/health", healthRoutes);

/**
 * ✅ Lang middleware (he default, supports he/ar)
 * Applied globally to all API routes after /health
 */
app.use(langMiddleware);

/**
 * ✅ Maintenance mode check
 * Blocks non-admin routes with 503 if SiteSettings.maintenanceMode.enabled = true
 */
app.use(maintenanceMiddleware());

/**
 * ✅ Route-level rate limits (tight for sensitive endpoints)
 * Apply on BOTH /api and /api/v1 for compatibility.
 */
app.use("/api/auth", limitAuth);
app.use("/api/orders/track", limitTrackOrder);
app.use("/api/checkout/quote", limitCheckoutQuote);
app.use("/api/checkout/cod", limitCheckoutCreate);
app.use("/api/checkout/stripe", limitCheckoutCreate);
app.use("/api/admin", limitAdmin);

app.use("/api/v1/auth", limitAuth);
app.use("/api/v1/orders/track", limitTrackOrder);
app.use("/api/v1/checkout/quote", limitCheckoutQuote);
app.use("/api/v1/checkout/cod", limitCheckoutCreate);
app.use("/api/v1/checkout/stripe", limitCheckoutCreate);
app.use("/api/v1/admin", limitAdmin);

/**
 * ✅ API v1 (CANONICAL)
 */
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/categories", categoriesRoutes);
app.use("/api/v1/products", rankingRoutes);
app.use("/api/v1/products", productsRoutes);
app.use("/api/v1/home", homeRoutes);
app.use("/api/v1/cart", cartRoutes);
app.use("/api/v1/shipping", shippingRoutes);
app.use("/api/v1/coupons", couponsRoutes);
app.use("/api/v1/offers", offersRoutes);
app.use("/api/v1/checkout", checkoutRoutes);
app.use("/api/v1/orders", ordersRoutes);
app.use("/api/v1/returns", returnsRoutes);
app.use("/api/v1/product-attributes", productAttributesRoutes);

// ✅ NEW
app.use("/api/v1/wishlist", wishlistRoutes);
app.use("/api/v1/reviews", reviewsRoutes);
app.use("/api/v1/content", contentRoutes);

// Admin-only
app.use("/api/v1/admin/returns", adminReturnsRoutes);
app.use("/api/v1/admin/orders", adminOrdersRoutes);
app.use("/api/v1/admin/audit-logs", adminAuditRoutes);
app.use("/api/v1/admin/users", adminUsersRoutes);
app.use("/api/v1/admin/content", adminContentRoutes);
app.use("/api/v1/admin/settings", adminSettingsRoutes);
app.use("/api/v1/admin/home-layout", adminHomeLayoutRoutes);
app.use("/api/v1/admin/media", adminMediaRoutes);
app.use("/api/v1/admin/product-attributes", adminProductAttributesRoutes);
app.use("/api/v1/admin/reviews", adminReviewsRoutes); // ✅ NEW
app.use("/api/v1/admin/dashboard", adminDashboardRoutes);
app.use("/api/v1/admin/categories", adminCategoriesRoutes);
app.use("/api/v1/admin/stock-reservations", adminStockReservationsRoutes);
app.use("/api/v1/admin/products", adminProductsRoutes);
app.use("/api/v1/admin", adminRoutes);

/**
 * ✅ Backward-compatible non-versioned routes (optional but recommended)
 * This prevents breaking older frontend calls that still use /api/*.
 */
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/products", rankingRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api/offers", offersRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/product-attributes", productAttributesRoutes);

app.use("/api/wishlist", wishlistRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/content", contentRoutes);

app.use("/api/admin/returns", adminReturnsRoutes);
app.use("/api/admin/product-attributes", adminProductAttributesRoutes);
app.use("/api/admin/products", adminProductsRoutes);
app.use("/api/admin/orders", adminOrdersRoutes);
app.use("/api/admin/audit-logs", adminAuditRoutes);
app.use("/api/admin/users", adminUsersRoutes);
app.use("/api/admin/content", adminContentRoutes);
app.use("/api/admin/settings", adminSettingsRoutes);
app.use("/api/admin/home-layout", adminHomeLayoutRoutes);
app.use("/api/admin/media", adminMediaRoutes);
app.use("/api/admin/reviews", adminReviewsRoutes); // ✅ NEW
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin/categories", adminCategoriesRoutes);
app.use("/api/admin/stock-reservations", adminStockReservationsRoutes);
app.use("/api/admin", adminRoutes);

/**
 * Global not-found + error handling
 */
app.use(notFound);
app.use(errorHandler);
