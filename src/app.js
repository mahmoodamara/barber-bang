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
import brandsRoutes from "./routes/brands.routes.js";
import searchRoutes from "./routes/search.routes.js";
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
import seoRoutes from "./routes/seo.routes.js";
import seoStaticRoutes from "./routes/seo.static.routes.js";
import newsletterRoutes from "./routes/newsletter.routes.js";
import stockNotifyRoutes from "./routes/stock-notify.routes.js";
import b2bRoutes from "./routes/b2b.routes.js";

import { errorHandler, notFound, getRequestId } from "./middleware/error.js";
import {
  getPrometheusMiddleware,
  getMetricsContent,
} from "./middleware/prometheus.js";
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
 * ✅ Request completion log
 */
app.use((req, res, next) => {
  const startTime = Date.now();

  res.once("finish", () => {
    const method = (req.method || "GET").toUpperCase();
    const canonicalPath = normalizePath(req.originalUrl);
    const statusCode = res.statusCode ?? 0;
    const durationMs = Date.now() - startTime;

    req.log.info(
      {
        statusCode,
        durationMs,
        contentLength: res.get("content-length") || 0,
      },
      `${method} ${canonicalPath}`,
    );
  });

  next();
});

/**
 * ✅ Optional: correlate requestId with OpenTelemetry span
 */
app.use((req, res, next) => {
  try {
    const { trace } = require("@opentelemetry/api");
    const span = trace.getActiveSpan();
    if (span && req.requestId) span.setAttribute("request.id", req.requestId);
  } catch {
    // tracing disabled / package missing
  }
  next();
});

/**
 * ✅ Prometheus metrics
 */
const metricsEnabled =
  String(process.env.ENABLE_METRICS || "false").toLowerCase() === "true";
if (metricsEnabled) {
  app.use(getPrometheusMiddleware());
}

/**
 * ✅ Normalize response envelope
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
 */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

/**
 * ✅ CSP — Production only
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
        "img-src": ["'self'", "https:", "data:"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "https:"],
        "font-src": ["'self'", "https:", "data:"],
      },
    }),
  );
}

/**
 * ✅ CORS
 * Supports comma-separated origins in env:
 * CORS_ORIGIN="https://barberbang.co.il,https://www.barberbang.co.il,http://localhost:5173"
 */
const corsOriginEnv = String(process.env.CORS_ORIGIN || "").trim();

const envOrigins = corsOriginEnv
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

const productionOrigins = new Set([
  "https://barberbang.co.il",
  "https://www.barberbang.co.il",
  "https://barber-bang.netlify.app",
]);

const allowedOrigins = new Set([
  ...envOrigins,
  ...productionOrigins,
]);

if (!isProd) {
  for (const origin of localhostOrigins) {
    allowedOrigins.add(origin);
  }
}

log.info(
  {
    isProd,
    corsOriginEnv,
    allowedOrigins: [...allowedOrigins],
  },
  "[cors] Allowed origins initialized",
);

const corsConfig = {
  origin(origin, cb) {
    // Allow non-browser clients: curl, Postman, backend-to-backend
    if (!origin) return cb(null, true);

    if (allowedOrigins.has(origin)) {
      return cb(null, true);
    }

    log.warn(
      {
        rejectedOrigin: origin,
        allowedOrigins: [...allowedOrigins],
      },
      "[cors] Origin rejected",
    );

    const err = new Error(`CORS_NOT_ALLOWED: ${origin}`);
    err.statusCode = 403;
    err.code = "CORS_NOT_ALLOWED";
    return cb(err);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Idempotency-Key",
    "Accept-Language",
    "x-guest-cart-id",
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsConfig));
app.options("*", cors(corsConfig));

/**
 * ✅ Global rate limit
 */
app.use(
  createLimiter({
    windowMs: 60_000,
    limit: 200,
    keyGenerator: (req) => req.ip,
  }),
);

// Morgan disabled - using single pino structured logger
// if (!isProd) {
//   morgan.token("req-id", (req) => req.requestId || "-");
//   app.use(morgan(":method :url :status :res[content-length] - :response-time ms :req-id"));
// }

/**
 * Legacy /api prefix
 */
let legacyApiWarned = false;
function legacyApiDeprecation(req, res, next) {
  if (String(req.url || "").startsWith("/v1")) return next();

  res.setHeader("X-API-Deprecated", "true");
  if (!legacyApiWarned) {
    legacyApiWarned = true;
    log.warn(
      { path: req.url },
      "[api] Legacy /api routes are deprecated. Use /api/v1.",
    );
  }
  return next();
}

/**
 * Stripe webhook must receive RAW body
 */
app.use("/api", legacyApiDeprecation);
app.use("/api/stripe/webhook", stripeWebhookRoutes);
app.use("/api/v1/stripe/webhook", stripeWebhookRoutes);

/**
 * Body parsers
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * NoSQL Injection defense
 */
app.use(
  mongoSanitize({
    replaceWith: "_",
  }),
);

/**
 * Optional global middlewares
 */
app.use(langMiddleware);
app.use(maintenanceMiddleware);

/**
 * API Router
 */
const apiRouter = express.Router();

// Auth
apiRouter.use("/auth", authRoutes);

// User features
apiRouter.use("/home", homeRoutes);
apiRouter.use("/categories", categoriesRoutes);
apiRouter.use("/products", productsRoutes);
apiRouter.use("/products", rankingRoutes);
apiRouter.use("/brands", brandsRoutes);
apiRouter.use("/search", searchRoutes);
apiRouter.use("/cart", limitCart, cartRoutes);
apiRouter.use("/shipping", shippingRoutes);
apiRouter.use("/coupons", couponsRoutes);
apiRouter.use("/offers", offersRoutes);
apiRouter.use("/checkout/quote", limitCheckoutQuote);
apiRouter.use("/checkout/cod", limitCheckoutCreate);
apiRouter.use("/checkout/send-otp", limitCheckoutCreate);
apiRouter.use("/checkout/verify-and-create", limitCheckoutCreate);
apiRouter.use("/checkout/stripe", limitCheckoutCreate);
apiRouter.use("/checkout", checkoutRoutes);
apiRouter.use("/orders/track", limitTrackOrder, ordersRoutes);
apiRouter.use("/orders", ordersRoutes);
apiRouter.use("/returns", returnsRoutes);
apiRouter.use("/product-attributes", productAttributesRoutes);
apiRouter.use("/wishlist", requireAuth(), wishlistRoutes);
apiRouter.use("/reviews", requireAuth(), reviewsRoutes);
apiRouter.use("/content", contentRoutes);
apiRouter.use("/collections", collectionsRoutes);
apiRouter.use("/settings", settingsRoutes);
apiRouter.use("/seo", seoRoutes);
apiRouter.use("/newsletter", newsletterRoutes);
apiRouter.use("/stock-notify", stockNotifyRoutes);
apiRouter.use("/b2b", b2bRoutes);

// Admin
apiRouter.use("/admin", limitAdmin, adminIndexRouter);

// Health
apiRouter.use("/health", healthRoutes);

// Metrics
if (metricsEnabled) {
  const metricsHandler = async (_req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const content = await getMetricsContent();
    return res.send(content);
  };

  const metricsAuth = isProd ? [requireAuth(), requireRole("admin")] : [];

  apiRouter.get("/metrics", ...metricsAuth, metricsHandler);
  app.get("/metrics", ...metricsAuth, metricsHandler);
}

// Canonical
app.use("/api/v1", apiRouter);

// Legacy
app.use("/api", legacyApiDeprecation, apiRouter);

// Public crawlability endpoints
app.use("/", seoStaticRoutes);

/**
 * Global not-found + error handling
 */
app.use(notFound);
app.use(errorHandler);