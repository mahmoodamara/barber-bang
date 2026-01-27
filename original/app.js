// src/app.js

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { langMiddleware } from "./middleware/lang.js";
import {
  limitAuth,
  limitCheckoutQuote,
  limitCheckoutCreate,
  limitTrackOrder,
} from "./middleware/rateLimit.js";

import authRoutes from "./routes/auth.routes.js";
import categoriesRoutes from "./routes/categories.routes.js";
import productsRoutes from "./routes/products.routes.js";
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

// ✅ NEW
import wishlistRoutes from "./routes/wishlist.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import contentRoutes from "./routes/content.routes.js";

import { errorHandler, notFound, getRequestId } from "./middleware/error.js";
import { metricsMiddleware, getMetricsSnapshot } from "./middleware/metrics.js";

export const app = express();

app.disable("x-powered-by");

/**
 * Request ID (safe for logs; no body/header logging)
 */
app.use((req, res, next) => {
  req.requestId = getRequestId(req);
  res.setHeader("x-request-id", req.requestId);
  next();
});

/**
 * ✅ Behind proxy support (Render / Nginx / Cloudflare)
 * Required so req.ip + secure cookies behave correctly.
 */
app.set("trust proxy", 1);

/**
 * ✅ Helmet defaults
 */
app.use(helmet());

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

const isProd = process.env.NODE_ENV === "production";
const localhostOrigins = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
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
  rateLimit({
    windowMs: 60_000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

if (process.env.NODE_ENV !== "production") {
  morgan.token("req-id", (req) => req.requestId || "-");
  app.use(morgan(":method :url :status :res[content-length] - :response-time ms :req-id"));
}

/**
 * ✅ IMPORTANT:
 * Stripe webhook must receive RAW body for signature verification.
 * This route must be mounted BEFORE express.json().
 */
app.use("/api/stripe/webhook", stripeWebhookRoutes);
app.use("/api/v1/stripe/webhook", stripeWebhookRoutes);

/**
 * ✅ Body parsers (after webhook)
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * ✅ Metrics
 */
const metricsEnabled = String(process.env.ENABLE_METRICS || "false").toLowerCase() === "true";
if (metricsEnabled) {
  app.use(metricsMiddleware());
  app.get("/api/v1/metrics", (_req, res) => res.json(getMetricsSnapshot()));
}

/**
 * ✅ Health endpoints
 * Keep both /health + /api/v1/health/* for Render monitors
 */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "simple-shop-v2" });
});

app.use("/api/v1/health", healthRoutes);

/**
 * ✅ Lang middleware (he default, supports he/ar)
 * Applied globally to all API routes after /health
 */
app.use(langMiddleware);

/**
 * ✅ Route-level rate limits (tight for sensitive endpoints)
 * Apply on BOTH /api and /api/v1 for compatibility.
 */
app.use("/api/auth", limitAuth);
app.use("/api/orders/track", limitTrackOrder);
app.use("/api/checkout/quote", limitCheckoutQuote);
app.use("/api/checkout/cod", limitCheckoutCreate);
app.use("/api/checkout/stripe", limitCheckoutCreate);

app.use("/api/v1/auth", limitAuth);
app.use("/api/v1/orders/track", limitTrackOrder);
app.use("/api/v1/checkout/quote", limitCheckoutQuote);
app.use("/api/v1/checkout/cod", limitCheckoutCreate);
app.use("/api/v1/checkout/stripe", limitCheckoutCreate);

/**
 * ✅ API v1 (CANONICAL)
 */
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/categories", categoriesRoutes);
app.use("/api/v1/products", productsRoutes);
app.use("/api/v1/home", homeRoutes);
app.use("/api/v1/cart", cartRoutes);
app.use("/api/v1/shipping", shippingRoutes);
app.use("/api/v1/coupons", couponsRoutes);
app.use("/api/v1/offers", offersRoutes);
app.use("/api/v1/checkout", checkoutRoutes);
app.use("/api/v1/orders", ordersRoutes);

// ✅ NEW
app.use("/api/v1/wishlist", wishlistRoutes);
app.use("/api/v1/reviews", reviewsRoutes);
app.use("/api/v1/content", contentRoutes);

// Admin-only
app.use("/api/v1/admin", adminRoutes);

/**
 * ✅ Backward-compatible non-versioned routes (optional but recommended)
 * This prevents breaking older frontend calls that still use /api/*.
 */
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/shipping", shippingRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api/offers", offersRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", ordersRoutes);

app.use("/api/wishlist", wishlistRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/content", contentRoutes);

app.use("/api/admin", adminRoutes);

/**
 * Global not-found + error handling
 */
app.use(notFound);
app.use(errorHandler);
