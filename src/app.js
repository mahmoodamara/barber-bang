// src/app.js

import { createRequire } from "node:module";
import express from "express";

const require = createRequire(import.meta.url);
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
  limitCart,
} from "./middleware/rateLimit.js";

import authRoutes from "./routes/auth.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import productsRoutes from "./routes/products.routes.js";
import collectionsRoutes from "./routes/collections.routes.js";

import rankingRoutes from "./routes/ranking.routes.js";
import homeRoutes from "./routes/home.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import shippingRoutes from "./routes/shipping.routes.js";
import couponsRoutes from "./routes/coupons.routes.js";
import offersRoutes from "./routes/offers.routes.js";
import checkoutRoutes from "./routes/checkout.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import stripeWebhookRoutes from "./routes/stripe.webhook.routes.js";
import adminIndexRouter from "./routes/admin.index.js";
import healthRoutes from "./routes/health.routes.js";
import returnsRoutes from "./routes/returns.routes.js";
import productAttributesRoutes from "./routes/product-attributes.routes.js";

import wishlistRoutes from "./routes/wishlist.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import contentRoutes from "./routes/content.routes.js";
import settingsRoutes from "./routes/settings.routes.js";

import { errorHandler, notFound, getRequestId } from "./middleware/error.js";
import { getPrometheusMiddleware, getMetricsContent } from "./middleware/prometheus.js";
import { log, reqLogger } from "./utils/logger.js";
import { normalizePath } from "./utils/path.js";

// ✅ Securing metrics (admin only in production)
import { requireAuth, requireRole } from "./middleware/auth.js";

export const app = express();

const isProd = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
const trustProxyEnv = String(process.env.TRUST_PROXY || "")
  .trim()
  .toLowerCase();
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
 * ✅ Structured logger per request (requestId, route, method)
 */
app.use((req, res, next) => {
  req.log = reqLogger(req);
  next();
});

/**
 * ✅ Request completion log (method, canonical path, statusCode, requestId) for all requests
 * - Single log entry per request (no duplicates)
 * - Canonical path from req.originalUrl (query stripped, trailing slash normalized)
 * - Uses requestId for correlation
 */
app.use((req, res, next) => {
  // Mark start time for duration calculation
  const startTime = Date.now();

  res.once("finish", () => {
    const method = (req.method || "GET").toUpperCase();
    const canonicalPath = normalizePath(req.originalUrl);
    const statusCode = res.statusCode ?? 0;
    const durationMs = Date.now() - startTime;

    // Single structured log entry with all relevant fields
    req.log.info({
      statusCode,
      durationMs,
      contentLength: res.get("content-length") || 0,
    }, `${method} ${canonicalPath}`);
  });
  next();
});

/**
 * ✅ Optional: correlate requestId with OpenTelemetry span (when ENABLE_TRACING=true)
 */
app.use((req, res, next) => {
  try {
    const { trace } = require("@opentelemetry/api");
    const span = trace.getActiveSpan();
    if (span && req.requestId) span.setAttribute("request.id", req.requestId);
  } catch {
    // @opentelemetry/api not installed or tracing disabled
  }
  next();
});

/**
 * ✅ Prometheus metrics (early so webhook and all routes are timed)
 */
const metricsEnabled = String(process.env.ENABLE_METRICS || "false").toLowerCase() === "true";
if (metricsEnabled) {
  app.use(getPrometheusMiddleware());
}

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
  }),
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
    }),
  );
}

/**
 * ✅ CORS
 * Supports comma-separated origins in env:
 * CORS_ORIGIN="https://site.com,http://localhost:5173"
 * In production, if CORS_ORIGIN is empty, defaults to frontend URL below.
 */
const DEFAULT_FRONTEND_ORIGIN = "http://localhost:8080";
const corsOriginEnv = String(process.env.CORS_ORIGIN || "").trim();
let corsOriginList = corsOriginEnv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Always include default frontend origin (fixes CORS when env not set on Render)
if (!corsOriginList.includes(DEFAULT_FRONTEND_ORIGIN)) {
  corsOriginList.push(DEFAULT_FRONTEND_ORIGIN);
}

log.info({ corsOriginList, isProd }, "[cors] Allowed origins");

const localhostOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "http://localhost:8080",
]);

// Production frontend origins (always allowed)
const productionOrigins = new Set(["http://localhost:8080", "https://barber-bang.netlify.app"]);

const allowedOrigins = new Set(corsOriginList);
// Always allow production frontend origins
for (const o of productionOrigins) allowedOrigins.add(o);
// Allow localhost origins in development
if (!isProd) {
  for (const o of localhostOrigins) allowedOrigins.add(o);
}

const corsConfig = {
  origin: (origin, cb) => {
    // Allow server-to-server / curl / Postman with no origin
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);

    // Log rejected origins for debugging
    log.warn({ origin, allowedOrigins: [...allowedOrigins] }, "[cors] Origin rejected");

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
  }),
);

// Morgan disabled - using single pino structured logger for request completion
// This avoids duplicate log entries with the same method/route/requestId
// if (!isProd) {
//   morgan.token("req-id", (req) => req.requestId || "-");
//   app.use(morgan(":method :url :status :res[content-length] - :response-time ms :req-id"));
// }

/**
 * Legacy /api prefix (backward compatible)
 */
let legacyApiWarned = false;
function legacyApiDeprecation(req, res, next) {
  if (String(req.url || "").startsWith("/v1")) return next();

  res.setHeader("X-API-Deprecated", "true");
  if (!legacyApiWarned) {
    legacyApiWarned = true;
    log.warn({ path: req.url }, "[api] Legacy /api routes are deprecated. Use /api/v1.");
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
  }),
);

/**
 * ✅ API Router (Unified)
 * Mounted at:
 * 1. /api/v1 (Canonical)
 * 2. /api    (Legacy/Alias)
 */
const apiRouter = express.Router();

// 1. Webhooks (Raw) - Already handled before json/urlencoded middleware
// apiRouter.use("/stripe/webhook", stripeWebhookRoutes); // Handled at app-level

// 2. Auth (rate limits applied per-route inside auth.routes.js)
apiRouter.use("/auth", authRoutes);

// 3. User features
apiRouter.use("/home", homeRoutes);
apiRouter.use("/categories", categoriesRoutes);
apiRouter.use("/products", productsRoutes);
apiRouter.use("/products", rankingRoutes);
apiRouter.use("/cart", limitCart, cartRoutes);
apiRouter.use("/shipping", shippingRoutes);
apiRouter.use("/coupons", couponsRoutes);
apiRouter.use("/offers", offersRoutes);
apiRouter.use("/checkout/quote", limitCheckoutQuote); // Rate limit
apiRouter.use("/checkout/cod", limitCheckoutCreate); // Rate limit
apiRouter.use("/checkout/stripe", limitCheckoutCreate); // Rate limit
apiRouter.use("/checkout", checkoutRoutes);
apiRouter.use("/orders/track", limitTrackOrder, ordersRoutes); // Specific limit for track
apiRouter.use("/orders", ordersRoutes);
apiRouter.use("/returns", returnsRoutes);
apiRouter.use("/product-attributes", productAttributesRoutes);
apiRouter.use("/wishlist", requireAuth(), wishlistRoutes);
apiRouter.use("/reviews", requireAuth(), reviewsRoutes);
apiRouter.use("/content", contentRoutes);
apiRouter.use("/collections", collectionsRoutes);
apiRouter.use("/settings", settingsRoutes);

// 4. Admin (Protected)
apiRouter.use("/admin", limitAdmin, adminIndexRouter);

// 5. Health (also mounted at root /health)
apiRouter.use("/health", healthRoutes);

// 6. Metrics (if enabled)
if (metricsEnabled) {
  const metricsHandler = async (_req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const content = await getMetricsContent();
    return res.send(content);
  };

  const metricsAuth = isProd ? [requireAuth(), requireRole("admin")] : [];

  apiRouter.get("/metrics", ...metricsAuth, metricsHandler);

  // QA hits GET /metrics at root (same handler + auth)
  app.get("/metrics", ...metricsAuth, metricsHandler);
}

// ✅ Mount Canonical (/api/v1)
app.use("/api/v1", apiRouter);

// ✅ Mount Legacy (/api) with deprecation warning
app.use("/api", legacyApiDeprecation, apiRouter);

/**
 * Global not-found + error handling
 */
app.use(notFound);
app.use(errorHandler);
